import { Component, HostBinding } from '@angular/core'
import { ConfigService, HostAppService, Platform, PlatformService, altKeyName, metaKeyName } from 'tabby-core'

/** @hidden */
@Component({
    templateUrl: './terminalSettingsTab.component.pug',
})
export class TerminalSettingsTabComponent {
    Platform = Platform
    altKeyName = altKeyName
    metaKeyName = metaKeyName

    @HostBinding('class.content-box') true

    constructor (
        public config: ConfigService,
        public hostApp: HostAppService,
        private platform: PlatformService,
    ) { }

    openWSLVolumeMixer (): void {
        this.platform.openPath('sndvol.exe')
        this.platform.exec('wsl.exe', ['tput', 'bel'])
    }

    get agentDetectionCommandsText (): string {
        return this.agentNotifications.detectionCommands.join('\n')
    }

    set agentDetectionCommandsText (value: string) {
        this.agentNotifications.detectionCommands = this.parseList(value)
        this.config.save()
    }

    get agentCompletionPatternsText (): string {
        return this.agentNotifications.completionPatterns.join('\n')
    }

    set agentCompletionPatternsText (value: string) {
        this.agentNotifications.completionPatterns = this.parseList(value)
        this.config.save()
    }

    private get agentNotifications (): any {
        this.config.store.terminal.agentNotifications ??= {}
        this.config.store.terminal.agentNotifications.detectionCommands ??= []
        this.config.store.terminal.agentNotifications.completionPatterns ??= []
        this.config.store.terminal.agentNotifications.enabled ??= true
        return this.config.store.terminal.agentNotifications
    }

    private parseList (value: string): string[] {
        return [...new Set(value
            .split(/\r\n|\r|\n|,/g)
            .map(x => x.trim().toLowerCase())
            .filter(x => !!x))]
    }
}
