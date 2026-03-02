import { Component, HostBinding } from '@angular/core'
import { WIN_BUILD_CONPTY_SUPPORTED, WIN_BUILD_CONPTY_STABLE, isWindowsBuild, ConfigService } from 'tabby-core'

interface FolderShortcut {
    label: string
    path: string
}

/** @hidden */
@Component({
    templateUrl: './shellSettingsTab.component.pug',
})
export class ShellSettingsTabComponent {
    isConPTYAvailable: boolean
    isConPTYStable: boolean

    @HostBinding('class.content-box') true

    constructor (
        public config: ConfigService,
    ) {
        this.isConPTYAvailable = isWindowsBuild(WIN_BUILD_CONPTY_SUPPORTED)
        this.isConPTYStable = isWindowsBuild(WIN_BUILD_CONPTY_STABLE)
    }

    get folderShortcuts (): FolderShortcut[] {
        this.config.store.terminal.folderShortcuts ??= []
        return this.config.store.terminal.folderShortcuts
    }

    addFolderShortcut (): void {
        this.folderShortcuts.push({
            label: '',
            path: '',
        })
        this.config.save()
    }

    removeFolderShortcut (index: number): void {
        this.folderShortcuts.splice(index, 1)
        this.config.save()
    }

    saveFolderShortcuts (): void {
        this.config.store.terminal.folderShortcuts = this.folderShortcuts.map(shortcut => ({
            label: shortcut.label,
            path: shortcut.path,
        }))
        this.config.save()
    }
}
