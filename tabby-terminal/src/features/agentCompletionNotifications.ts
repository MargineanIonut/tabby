import { Injectable } from '@angular/core'
import { ConfigService, LogService, Logger } from 'tabby-core'
import { TerminalDecorator } from '../api/decorator'
import { BaseTerminalTabComponent } from '../api/baseTerminalTab.component'

const DEFAULT_AGENT_COMMANDS = ['claude', 'codex', 'aider', 'opencode', 'copilot']
const DEFAULT_COMPLETION_PATTERNS = ['done', 'completed', 'finished', 'success']
const PROCESS_POLL_INTERVAL_MS = 1000
const COMPLETION_IDLE_MS = 1500
const TRACKED_SUBMISSION_GRACE_MS = 300
const FOCUSED_FLASH_DURATION_MS = 3000
const WINDOWS_EXECUTABLE_EXTENSION_REGEX = /\.(exe|cmd|bat|ps1|sh)$/i
const WORD_BOUNDARY_ESCAPE_REGEX = /[.*+?^${}()|[\]\\]/g
const ANSI_ESCAPE_REGEX = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
const TYPED_SESSION_EXIT_COMMANDS = new Set(['exit', 'quit', 'logout'])
const COPILOT_SPINNER_OUTPUT_REGEX = /(?:^|\r?\n)\s*[◐◓◑◒]\s+/m
const COPILOT_RESPONSE_OUTPUT_REGEX = /(?:^|\r?\n)\s*[●•]\s+\S/m

interface AgentDetectionSettings {
    enabled: boolean
    detectionCommands: string[]
    completionPatterns: string[]
}

interface RuntimeState {
    trackedAgentProcessName: string | null
    trackedSource: 'process' | 'typed' | null
    matchedCompletionPattern: boolean
    pendingOutputLine: string
    awaitingTurnCompletion: boolean
    outputSeenInTurn: boolean
    inputLineBuffer: string
    lastSubmissionAt: number
    lastProcessPresent: boolean
    pollInFlight: boolean
    copilotTurnActive: boolean
    pollInterval?: ReturnType<typeof setInterval>
    flashTimeout?: ReturnType<typeof setTimeout>
    idleCompletionTimeout?: ReturnType<typeof setTimeout>
}

/** @hidden */
@Injectable()
export class AgentCompletionNotificationsDecorator extends TerminalDecorator {
    private runtimes = new Map<BaseTerminalTabComponent<any>, RuntimeState>()
    private logger: Logger

    constructor (
        private config: ConfigService,
        log: LogService,
    ) {
        super()
        this.logger = log.create('agentNotify')
    }

    attach (terminal: BaseTerminalTabComponent<any>): void {
        const runtime = this.ensureRuntime(terminal)

        this.subscribeUntilDetached(terminal, terminal.output$.subscribe(data => {
            this.onOutputData(terminal, runtime, data)
        }))

        this.subscribeUntilDetached(terminal, terminal.input$.subscribe(data => {
            this.onInputData(terminal, runtime, data)
        }))

        if (terminal.frontend) {
            this.subscribeUntilDetached(terminal, terminal.frontend.mouseEvent$.subscribe(event => {
                if (event.type === 'mousedown') {
                    this.clearUnreadNotification(terminal)
                }
            }))
        }

        runtime.pollInterval = setInterval(() => {
            this.pollTerminal(terminal, runtime).catch(error => {
                this.logger.warn('Agent completion poll failed:', error)
            })
        }, PROCESS_POLL_INTERVAL_MS)
        this.pollTerminal(terminal, runtime).catch(error => {
            this.logger.warn('Initial agent completion poll failed:', error)
        })
    }

    detach (terminal: BaseTerminalTabComponent<any>): void {
        const runtime = this.runtimes.get(terminal)
        if (runtime?.pollInterval) {
            clearInterval(runtime.pollInterval)
        }
        if (runtime?.flashTimeout) {
            clearTimeout(runtime.flashTimeout)
        }
        if (runtime?.idleCompletionTimeout) {
            clearTimeout(runtime.idleCompletionTimeout)
        }
        terminal.agentNotificationFlash = false
        this.runtimes.delete(terminal)
        super.detach(terminal)
    }

    private ensureRuntime (terminal: BaseTerminalTabComponent<any>): RuntimeState {
        if (!this.runtimes.has(terminal)) {
            this.runtimes.set(terminal, {
                trackedAgentProcessName: null,
                trackedSource: null,
                matchedCompletionPattern: false,
                pendingOutputLine: '',
                awaitingTurnCompletion: false,
                outputSeenInTurn: false,
                inputLineBuffer: '',
                lastSubmissionAt: 0,
                lastProcessPresent: false,
                pollInFlight: false,
                copilotTurnActive: false,
            })
        }
        return this.runtimes.get(terminal)!
    }

    private async pollTerminal (terminal: BaseTerminalTabComponent<any>, runtime: RuntimeState): Promise<void> {
        if (runtime.pollInFlight) {
            return
        }
        runtime.pollInFlight = true

        try {
            const settings = this.getSettings()
            if (!settings.enabled) {
                this.resetTracking(runtime)
                runtime.lastProcessPresent = false
                return
            }

            const process = await terminal.getCurrentProcess()
            const processName = process?.name?.trim() || null
            const isAgentProcess = processName ? this.matchesAgentProcess(processName, settings.detectionCommands) : false
            runtime.lastProcessPresent = !!processName

            if (!runtime.trackedAgentProcessName) {
                if (isAgentProcess) {
                    runtime.trackedAgentProcessName = processName
                    runtime.trackedSource = 'process'
                    runtime.matchedCompletionPattern = false
                    runtime.pendingOutputLine = ''
                    runtime.awaitingTurnCompletion = false
                    runtime.outputSeenInTurn = false
                }
                return
            }

            if (runtime.trackedSource === 'typed') {
                if (isAgentProcess) {
                    runtime.trackedAgentProcessName = processName
                    runtime.trackedSource = 'process'
                    return
                }
                if (!processName && runtime.awaitingTurnCompletion && Date.now() - runtime.lastSubmissionAt >= TRACKED_SUBMISSION_GRACE_MS) {
                    this.onTrackedAgentCompleted(terminal, runtime)
                    runtime.awaitingTurnCompletion = false
                    runtime.outputSeenInTurn = false
                    runtime.matchedCompletionPattern = false
                    runtime.pendingOutputLine = ''
                    if (runtime.idleCompletionTimeout) {
                        clearTimeout(runtime.idleCompletionTimeout)
                        runtime.idleCompletionTimeout = undefined
                    }
                }
                return
            }

            if (isAgentProcess) {
                runtime.trackedAgentProcessName = processName
                return
            }

            this.onTrackedAgentCompleted(terminal, runtime)
            this.resetTracking(runtime)
        } finally {
            runtime.pollInFlight = false
        }
    }

    private onOutputData (terminal: BaseTerminalTabComponent<any>, runtime: RuntimeState, data: string): void {
        if (COPILOT_SPINNER_OUTPUT_REGEX.test(data)) {
            runtime.copilotTurnActive = true
            if (!runtime.trackedAgentProcessName) {
                runtime.trackedAgentProcessName = 'copilot'
                runtime.trackedSource = 'typed'
            }
            if (!runtime.awaitingTurnCompletion) {
                this.armTurn(runtime)
            }
        }

        if (COPILOT_RESPONSE_OUTPUT_REGEX.test(data) && (runtime.copilotTurnActive || runtime.trackedAgentProcessName === 'copilot')) {
            if (!runtime.trackedAgentProcessName) {
                runtime.trackedAgentProcessName = 'copilot'
                runtime.trackedSource = 'typed'
            }
            this.onTrackedAgentCompleted(terminal, runtime)
            runtime.awaitingTurnCompletion = false
            runtime.outputSeenInTurn = false
            runtime.matchedCompletionPattern = false
            runtime.pendingOutputLine = ''
            runtime.copilotTurnActive = false
            if (runtime.idleCompletionTimeout) {
                clearTimeout(runtime.idleCompletionTimeout)
                runtime.idleCompletionTimeout = undefined
            }
            return
        }

        if (!runtime.trackedAgentProcessName) {
            return
        }

        if (runtime.awaitingTurnCompletion) {
            runtime.outputSeenInTurn = true
            this.scheduleIdleTurnCompletion(terminal, runtime)
        }

        if (runtime.matchedCompletionPattern) {
            return
        }

        const patterns = this.getSettings().completionPatterns
        if (!patterns.length) {
            return
        }

        const allOutput = `${runtime.pendingOutputLine}${data}`
        const lines = allOutput.split(/\r\n|\r|\n/g)
        runtime.pendingOutputLine = lines.pop() ?? ''

        for (const line of lines) {
            if (patterns.some(pattern => this.matchesCompletionPattern(line, pattern))) {
                runtime.matchedCompletionPattern = true
                return
            }
        }
    }

    private scheduleIdleTurnCompletion (terminal: BaseTerminalTabComponent<any>, runtime: RuntimeState): void {
        if (runtime.idleCompletionTimeout) {
            clearTimeout(runtime.idleCompletionTimeout)
        }
        runtime.idleCompletionTimeout = setTimeout(() => {
            if (!runtime.trackedAgentProcessName) {
                runtime.idleCompletionTimeout = undefined
                return
            }
            if (!runtime.awaitingTurnCompletion || !runtime.outputSeenInTurn) {
                runtime.idleCompletionTimeout = undefined
                return
            }
            this.onTrackedAgentCompleted(terminal, runtime)
            runtime.awaitingTurnCompletion = false
            runtime.outputSeenInTurn = false
            runtime.matchedCompletionPattern = false
            runtime.pendingOutputLine = ''
            runtime.idleCompletionTimeout = undefined
        }, COMPLETION_IDLE_MS)
    }

    private onTrackedAgentCompleted (terminal: BaseTerminalTabComponent<any>, runtime: RuntimeState): void {
        if (terminal.hasFocus) {
            terminal.agentNotificationFlash = true
            if (runtime.flashTimeout) {
                clearTimeout(runtime.flashTimeout)
            }
            runtime.flashTimeout = setTimeout(() => {
                terminal.agentNotificationFlash = false
                runtime.flashTimeout = undefined
            }, FOCUSED_FLASH_DURATION_MS)
            return
        }

        if (!terminal.agentNotificationUnread) {
            terminal.agentNotificationUnread = true
            terminal.markRecoveryStateChanged()
        }
    }

    private clearUnreadNotification (terminal: BaseTerminalTabComponent<any>): void {
        if (!terminal.agentNotificationUnread) {
            return
        }
        terminal.agentNotificationUnread = false
        terminal.markRecoveryStateChanged()
    }

    private getSettings (): AgentDetectionSettings {
        const source = this.config.store.terminal.agentNotifications ?? {}
        const detectionCommands = this.normalizeConfigList(source.detectionCommands, DEFAULT_AGENT_COMMANDS, true)
        const completionPatterns = this.normalizeConfigList(source.completionPatterns, DEFAULT_COMPLETION_PATTERNS)
        return {
            enabled: source.enabled !== false,
            detectionCommands,
            completionPatterns,
        }
    }

    private normalizeConfigList (value: unknown, fallback: string[], includeFallbackValues = false): string[] {
        if (!(value instanceof Array)) {
            return [...fallback]
        }
        const cleaned = value
            .filter(x => typeof x === 'string')
            .map(x => x.trim().toLowerCase())
            .filter(x => !!x)
            .map(x => x.replace(WINDOWS_EXECUTABLE_EXTENSION_REGEX, ''))
        const deduped = [...new Set(includeFallbackValues ? [...fallback, ...cleaned] : cleaned)]
        return deduped.length ? deduped : [...fallback]
    }

    private matchesAgentProcess (processName: string, commands: string[]): boolean {
        const token = processName.trim().toLowerCase().split(/\s+/)[0] ?? ''
        const leaf = token.split(/[\\/]/).pop() ?? token
        const normalizedLeaf = leaf.replace(WINDOWS_EXECUTABLE_EXTENSION_REGEX, '')
        return commands.includes(normalizedLeaf)
    }

    private matchesCompletionPattern (line: string, pattern: string): boolean {
        const escapedPattern = pattern.replace(WORD_BOUNDARY_ESCAPE_REGEX, '\\$&')
        const regex = new RegExp(`\\b${escapedPattern}\\b`, 'i')
        return regex.test(line)
    }

    private onInputData (terminal: BaseTerminalTabComponent<any>, runtime: RuntimeState, data: Buffer): void {
        if (data.length > 0) {
            this.clearUnreadNotification(terminal)
        }

        const text = data
            .toString('utf-8')
            .replace(ANSI_ESCAPE_REGEX, '')
            .replace(/\u001b./g, '')

        for (const char of text) {
            if (char === '\r' || char === '\n') {
                this.onCommandSubmitted(runtime)
                runtime.inputLineBuffer = ''
                continue
            }
            if (char === '\b' || char === '\u007f') {
                runtime.inputLineBuffer = runtime.inputLineBuffer.slice(0, -1)
                continue
            }
            if (char >= ' ' && char !== '\u007f') {
                runtime.inputLineBuffer += char
            }
        }
    }

    private onCommandSubmitted (runtime: RuntimeState): void {
        const settings = this.getSettings()
        const hasInput = runtime.inputLineBuffer.trim().length > 0
        const commandToken = this.normalizeCommandToken(runtime.inputLineBuffer)
        const detectedAgentCommand = this.detectAgentCommandToken(runtime.inputLineBuffer, settings.detectionCommands)

        if (!hasInput) {
            if ((runtime.trackedSource === 'process' || runtime.trackedSource === 'typed') && runtime.lastProcessPresent) {
                this.armTurn(runtime)
            }
            return
        }

        if (runtime.trackedSource === 'process' && runtime.trackedAgentProcessName) {
            this.armTurn(runtime)
            return
        }

        if (runtime.trackedSource === 'typed' && runtime.trackedAgentProcessName) {
            if (commandToken && TYPED_SESSION_EXIT_COMMANDS.has(commandToken)) {
                this.resetTracking(runtime)
                return
            }
            if (detectedAgentCommand) {
                runtime.trackedAgentProcessName = detectedAgentCommand
                runtime.trackedSource = 'typed'
            }
            this.armTurn(runtime)
            return
        }

        if (detectedAgentCommand) {
            runtime.trackedAgentProcessName = detectedAgentCommand
            runtime.trackedSource = 'typed'
            this.armTurn(runtime)
        }
    }

    private armTurn (runtime: RuntimeState): void {
        runtime.awaitingTurnCompletion = true
        runtime.outputSeenInTurn = false
        runtime.matchedCompletionPattern = false
        runtime.pendingOutputLine = ''
        runtime.lastSubmissionAt = Date.now()
        if (runtime.idleCompletionTimeout) {
            clearTimeout(runtime.idleCompletionTimeout)
            runtime.idleCompletionTimeout = undefined
        }
    }

    private resetTracking (runtime: RuntimeState): void {
        runtime.trackedAgentProcessName = null
        runtime.trackedSource = null
        runtime.matchedCompletionPattern = false
        runtime.pendingOutputLine = ''
        runtime.awaitingTurnCompletion = false
        runtime.outputSeenInTurn = false
        runtime.copilotTurnActive = false
        runtime.inputLineBuffer = ''
        if (runtime.idleCompletionTimeout) {
            clearTimeout(runtime.idleCompletionTimeout)
            runtime.idleCompletionTimeout = undefined
        }
    }

    private detectAgentCommandToken (input: string, commands: string[]): string|null {
        const tokens = this.normalizeCommandTokens(input)
        if (!tokens.length) {
            return null
        }
        const candidates = [tokens[0]]
        if (tokens[0] === 'gh' && tokens[1]) {
            candidates.push(tokens[1])
        }
        return candidates.find(token => commands.includes(token)) ?? null
    }

    private normalizeCommandToken (input: string): string|null {
        return this.normalizeCommandTokens(input)[0] ?? null
    }

    private normalizeCommandTokens (input: string): string[] {
        return input
            .trim()
            .split(/\s+/)
            .map(token => this.normalizeCommandPart(token))
            .filter((token): token is string => !!token)
    }

    private normalizeCommandPart (token: string): string|null {
        const unquoted = token.replace(/^['"]|['"]$/g, '')
        const leaf = unquoted.split(/[\\/]/).pop() ?? unquoted
        const normalized = leaf.toLowerCase().replace(WINDOWS_EXECUTABLE_EXTENSION_REGEX, '')
        return normalized || null
    }
}
