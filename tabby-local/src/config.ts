import { ConfigProvider, Platform } from 'tabby-core'

/** @hidden */
export class TerminalConfigProvider extends ConfigProvider {
    defaults = {
        terminal: {
            autoOpen: true,
            useConPTY: true,
            environment: {},
            setComSpec: false,
            folderShortcutMaxVisible: 3,
            folderShortcuts: [],
        },
    }

    platformDefaults = {
        [Platform.macOS]: {
            terminal: {
                profile: 'local:default',
            },
            hotkeys: {
                'new-tab': [
                    '⌘-T',
                ],
            },
        },
        [Platform.Windows]: {
            terminal: {
                profile: 'local:cmd-clink',
                folderShortcuts: [
                    {
                        label: 'Compass',
                        path: 'C:\\Users\\ionut\\Desktop\\therapy\\therapy-dashboard',
                    },
                    {
                        label: 'Trading',
                        path: 'C:\\Users\\ionut\\Desktop\\workspace\\New folder\\trading-app',
                    },
                ],
            },
            hotkeys: {
                'new-tab': [
                    'Ctrl-Shift-T',
                ],
            },
        },
        [Platform.Linux]: {
            terminal: {
                profile: 'local:default',
            },
            hotkeys: {
                'new-tab': [
                    'Ctrl-Shift-T',
                ],
            },
        },
    }
}
