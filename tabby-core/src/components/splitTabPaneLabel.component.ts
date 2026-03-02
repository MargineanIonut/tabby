/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Component, Input, HostBinding, ElementRef, ViewChild } from '@angular/core'
import { HotkeysService } from '../services/hotkeys.service'
import { AppService } from '../services/app.service'
import { ConfigService } from '../services/config.service'
import { NotificationsService } from '../services/notifications.service'
import { BaseTabComponent } from './baseTab.component'
import { SplitTabComponent } from './splitTab.component'
import { SelfPositioningComponent } from './selfPositioning.component'

interface FolderShortcut {
    label: string
    path: string
}

/** @hidden */
@Component({
    selector: 'split-tab-pane-label',
    template: `
    <div
        class='pane-header'
        [class.focused]='parent.getFocusedTab() === tab'
        cdkDrag
        [cdkDragData]='tab'
        [cdkDragDisabled]='!isActive || isEditing'
        (cdkDragStarted)='onTabDragStart(tab)'
        (cdkDragEnded)='onTabDragEnd()'
        (mousedown)='focusPane()'
    >
        <i
            *ngIf='isActive'
            class='fas fa-grip-vertical drag-handle'
            cdkDragHandle
            (mousedown)='$event.stopPropagation()'
        ></i>
        <label
            *ngIf='!isEditing'
            (dblclick)='startEditing($event)'
            [title]='parent.getPaneDisplayTitle(tab)'
        >{{ parent.getPaneDisplayTitle(tab) }}</label>
        <button
            *ngFor='let shortcut of visibleFolderShortcuts'
            type='button'
            class='shortcut-button'
            (mousedown)='activateShortcut(shortcut.path, $event)'
        >{{ shortcut.label }}</button>
        <div
            class='shortcut-menu'
            ngbDropdown
            *ngIf='overflowFolderShortcuts.length > 0'
            (mousedown)='$event.stopPropagation()'
        >
            <button
                type='button'
                class='shortcut-button'
                ngbDropdownToggle
            >More</button>
            <div class='bg-dark' ngbDropdownMenu>
                <button
                    type='button'
                    ngbDropdownItem
                    *ngFor='let shortcut of overflowFolderShortcuts'
                    (mousedown)='activateShortcut(shortcut.path, $event)'
                >{{ shortcut.label }}</button>
            </div>
        </div>
        <input
            #nameInput
            *ngIf='isEditing'
            type='text'
            [maxlength]='32'
            [(ngModel)]='editValue'
            (mousedown)='$event.stopPropagation()'
            (keydown.enter)='saveEdit()'
            (keydown.escape)='cancelEdit()'
            (blur)='saveEdit()'
        />
        <button
            type='button'
            class='close-pane-button'
            (mousedown)='$event.stopPropagation()'
            (click)='closePane($event)'
        >&times;</button>
    </div>
    `,
    styleUrls: ['./splitTabPaneLabel.component.scss'],
})
export class SplitTabPaneLabelComponent extends SelfPositioningComponent {
    @Input() tab: BaseTabComponent
    @Input() parent: SplitTabComponent
    @ViewChild('nameInput') nameInput?: ElementRef<HTMLInputElement>
    @HostBinding('class.active') isActive = false
    isEditing = false
    editValue = ''

    // eslint-disable-next-line @typescript-eslint/no-useless-constructor
    constructor (
        element: ElementRef,
        hotkeys: HotkeysService,
        private app: AppService,
        private config: ConfigService,
        private notifications: NotificationsService,
    ) {
        super(element)
        this.subscribeUntilDestroyed(hotkeys.hotkey$, hk => {
            if (hk === 'rearrange-panes' && this.parent.hasFocus) {
                this.isActive = true
                this.layout()
            }
        })
        this.subscribeUntilDestroyed(hotkeys.hotkeyOff$, hk => {
            if (hk === 'rearrange-panes') {
                this.isActive = false
            }
        })
    }

    ngOnChanges () {
        this.layout()
    }

    ngDoCheck () {
        this.layout()
    }

    onTabDragStart (tab: BaseTabComponent): void {
        this.app.emitTabDragStarted(tab)
    }

    onTabDragEnd (): void {
        setTimeout(() => {
            this.app.emitTabDragEnded()
            this.app.emitTabsChanged()
        })
    }

    focusPane (): void {
        this.parent.focus(this.tab)
    }

    startEditing (event: MouseEvent): void {
        event.stopPropagation()
        this.isEditing = true
        this.editValue = this.parent.getPaneCustomTitle(this.tab) || this.parent.getPaneDisplayTitle(this.tab)
        setTimeout(() => {
            this.nameInput?.nativeElement.focus()
            this.nameInput?.nativeElement.select()
        })
    }

    saveEdit (): void {
        if (!this.isEditing) {
            return
        }
        this.parent.setPaneCustomTitle(this.tab, this.editValue)
        this.isEditing = false
    }

    cancelEdit (): void {
        this.isEditing = false
    }

    async closePane (event: MouseEvent): Promise<void> {
        event.stopPropagation()
        await this.parent.closePane(this.tab)
    }

    get visibleFolderShortcuts (): FolderShortcut[] {
        return this.folderShortcuts.slice(0, this.maxVisibleFolderShortcuts)
    }

    get overflowFolderShortcuts (): FolderShortcut[] {
        return this.folderShortcuts.slice(this.maxVisibleFolderShortcuts)
    }

    async activateShortcut (path: string, event: MouseEvent): Promise<void> {
        event.preventDefault()
        event.stopPropagation()
        const restartableTab = this.tab as BaseTabComponent & { restartAtPath?: (targetPath: string) => Promise<boolean> }
        if (!restartableTab.restartAtPath) {
            this.notifications.notice('Folder shortcuts are available for local terminals only')
            return
        }
        this.parent.focus(this.tab)
        await restartableTab.restartAtPath(path)
    }

    layout () {
        const tabElement: HTMLElement|undefined = this.tab.viewContainerEmbeddedRef?.rootNodes[0]

        if (!tabElement) {
            // being destroyed
            return
        }

        const paneHeaderHeight = this.parent.getPaneHeaderHeightPx()
        this.setDimensions(
            tabElement.offsetLeft,
            tabElement.offsetTop - paneHeaderHeight,
            tabElement.clientWidth,
            paneHeaderHeight,
            'px',
        )
    }

    private get maxVisibleFolderShortcuts (): number {
        return Math.max(1, this.config.store.terminal.folderShortcutMaxVisible ?? 3)
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
