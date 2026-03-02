import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import { Component, Input, Injector, Inject, Optional, HostBinding } from '@angular/core'
import * as fsSync from 'fs'
import { BaseTabProcess, WIN_BUILD_CONPTY_SUPPORTED, isWindowsBuild, GetRecoveryTokenOptions, Platform, SplitTabComponent } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { LocalProfile, SessionOptions, UACService } from '../api'
import { Session } from '../session'

interface FolderShortcut {
    label: string
    path: string
}

/** @hidden */
@Component({
    selector: 'terminalTab',
    template: `${BaseTerminalTabComponent.template} ${require('./terminalTab.component.pug')}`,
    styles: [
        ...BaseTerminalTabComponent.styles,
        require('./terminalTab.component.scss'),
    ],
    animations: BaseTerminalTabComponent.animations,
})
export class TerminalTabComponent extends BaseTerminalTabComponent<LocalProfile> {
    @Input() sessionOptions: SessionOptions // Deprecated
    session: Session|null = null
    @HostBinding('class.with-folder-shortcuts') get hasFolderShortcuts (): boolean { return this.shouldShowFolderShortcutsBar }

    // eslint-disable-next-line @typescript-eslint/no-useless-constructor
    constructor (
        injector: Injector,
        @Optional() @Inject(UACService) private uac: UACService|undefined,
    ) {
        super(injector)
    }

    ngOnInit (): void {
        this.sessionOptions = this.profile.options

        this.logger = this.log.create('terminalTab')

        const isConPTY = isWindowsBuild(WIN_BUILD_CONPTY_SUPPORTED) && this.config.store.terminal.useConPTY

        this.subscribeUntilDestroyed(this.hotkeys.hotkey$, hotkey => {
            if (!this.hasFocus) {
                return
            }
            switch (hotkey) {
                case 'home':
                    this.sendInput(isConPTY ? '\x1b[H' : '\x1bOH')
                    break
                case 'end':
                    this.sendInput(isConPTY ? '\x1b[F' : '\x1bOF')
                    break
            }
        })

        super.ngOnInit()
    }

    protected onFrontendReady (): void {
        this.initializeSession(this.size.columns, this.size.rows)
        this.savedStateIsLive = this.profile.options.restoreFromPTYID === this.session?.getID()
        super.onFrontendReady()
    }

    get shouldShowFolderShortcutsBar (): boolean {
        return this.hostApp.platform === Platform.Windows &&
            !(this.topmostParent instanceof SplitTabComponent) &&
            this.folderShortcuts.length > 0
    }

    get visibleFolderShortcuts (): FolderShortcut[] {
        return this.folderShortcuts.slice(0, this.maxVisibleFolderShortcuts)
    }

    get overflowFolderShortcuts (): FolderShortcut[] {
        return this.folderShortcuts.slice(this.maxVisibleFolderShortcuts)
    }

    async onFolderShortcutClick (path: string, event?: MouseEvent): Promise<void> {
        event?.preventDefault()
        event?.stopPropagation()
        await this.restartAtPath(path)
    }

    async restartAtPath (targetPath: string): Promise<boolean> {
        const path = targetPath.trim()
        if (!path) {
            return false
        }
        if (!fsSync.existsSync(path)) {
            this.notifications.error(`Directory not found: ${path}`)
            return false
        }
        this.notifications.notice(`Switching to ${path}`)
        const session = this.session
        this.profile = {
            ...this.profile,
            options: {
                ...this.profile.options,
                cwd: path,
                restoreFromPTYID: null,
            },
        }
        if (session?.open) {
            this.sendInput(this.getPathSwitchCommand(path))
            this.recoveryStateChangedHint.next()
            return true
        }
        this.initializeSession(this.getSessionColumns(), this.getSessionRows())
        this.recoveryStateChangedHint.next()
        return true
    }

    initializeSession (columns: number, rows: number): void {

        const session = new Session(this.injector)

        if (this.profile.options.runAsAdministrator && this.uac?.isAvailable) {
            this.profile = {
                ...this.profile,
                options: this.uac.patchSessionOptionsForUAC(this.profile.options),
            }
        }

        session.start({
            ...this.profile.options,
            width: columns,
            height: rows,
        })

        this.setSession(session)
        this.recoveryStateChangedHint.next()
    }

    async getRecoveryToken (options?: GetRecoveryTokenOptions): Promise<any> {
        const cwd = this.session ? await this.session.getWorkingDirectory() : null
        return {
            type: 'app:local-tab',
            profile: {
                ...this.profile,
                options: {
                    ...this.profile.options,
                    cwd: cwd ?? this.profile.options.cwd,
                    restoreFromPTYID: options?.includeState && this.session?.getID(),
                },
            },
            savedState: options?.includeState && this.frontend?.saveState(),
        }
    }

    async getCurrentProcess (): Promise<BaseTabProcess|null> {
        const children = await this.session?.getChildProcesses()
        if (!children?.length) {
            return null
        }
        return {
            name: children[0].command,
        }
    }

    async canClose (): Promise<boolean> {
        const children = await this.session?.getChildProcesses()
        if (!children?.length) {
            return true
        }
        return (await this.platform.showMessageBox(
            {
                type: 'warning',
                message: this.translate.instant(
                    _('"{command}" is still running. Close?'),
                    children[0],
                ),
                buttons: [
                    this.translate.instant(_('Kill')),
                    this.translate.instant(_('Cancel')),
                ],
                defaultId: 0,
                cancelId: 1,
            },
        )).response === 0
    }

    ngOnDestroy (): void {
        super.ngOnDestroy()
        this.session?.destroy()
    }

    /**
     * Return true if the user explicitly exit the session.
     * Always return true for terminalTab as the session can only be ended by the user
     */
    protected isSessionExplicitlyTerminated (): boolean {
        return true
    }

    private get maxVisibleFolderShortcuts (): number {
        return Math.max(1, this.config.store.terminal.folderShortcutMaxVisible ?? 3)
    }

    private getSessionColumns (): number {
        return this.size?.columns ?? 80
    }

    private getSessionRows (): number {
        return this.size?.rows ?? 30
    }

    private getPathSwitchCommand (path: string): string {
        const baseCommand = this.sessionOptions.command.toLowerCase()
        if (baseCommand.includes('powershell') || baseCommand.includes('pwsh')) {
            return `Set-Location -LiteralPath '${path.replace(/'/g, '\'\'')}'\r`
        }
        const escapedPath = path.replace(/"/g, '""')
        if (baseCommand.includes('cmd.exe') || baseCommand.endsWith('\\cmd') || baseCommand === 'cmd') {
            return `cd /d "${escapedPath}"\r`
        }
        return `cd "${escapedPath}"\r`
    }

    private get folderShortcuts (): FolderShortcut[] {
        const shortcuts = this.config.store.terminal.folderShortcuts ?? []
        return shortcuts
            .filter(shortcut => typeof shortcut.label === 'string' && typeof shortcut.path === 'string')
            .map(shortcut => ({
                label: shortcut.label.trim(),
                path: shortcut.path.trim(),
            }))
            .filter(shortcut => !!shortcut.label && !!shortcut.path)
    }
}
