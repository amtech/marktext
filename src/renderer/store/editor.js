import { clipboard, ipcRenderer, shell } from 'electron'
import path from 'path'
import bus from '../bus'
import { hasKeys, getUniqueId } from '../util'
import { isSameFileSync } from '../util/fileSystem'
import listToTree from '../util/listToTree'
import { createDocumentState, getOptionsFromState, getSingleFileState, getBlankFileState } from './help'
import notice from '../services/notification'

const state = {
  lineEnding: 'lf',
  currentFile: {},
  tabs: [],
  toc: []
}

const mutations = {
  // set search key and matches also index
  SET_SEARCH (state, value) {
    state.currentFile.searchMatches = value
  },
  SET_TOC (state, toc) {
    state.toc = listToTree(toc)
  },
  SET_CURRENT_FILE (state, currentFile) {
    const oldCurrentFile = state.currentFile
    if (!oldCurrentFile.id || oldCurrentFile.id !== currentFile.id) {
      const { id, markdown, cursor, history, pathname } = currentFile
      window.DIRNAME = pathname ? path.dirname(pathname) : ''
      // set state first, then emit file changed event
      state.currentFile = currentFile
      bus.$emit('file-changed', { id, markdown, cursor, renderCursor: true, history })
    }
  },
  ADD_FILE_TO_TABS (state, currentFile) {
    state.tabs.push(currentFile)
  },
  REMOVE_FILE_WITHIN_TABS (state, file) {
    const { tabs, currentFile } = state
    const index = tabs.indexOf(file)
    tabs.splice(index, 1)
    state.tabs = tabs
    if (file.id === currentFile.id) {
      const fileState = state.tabs[index] || state.tabs[index - 1] || state.tabs[0] || {}
      state.currentFile = fileState
      if (typeof fileState.markdown === 'string') {
        const { id, markdown, cursor, history, pathname } = fileState
        window.DIRNAME = pathname ? path.dirname(pathname) : ''
        bus.$emit('file-changed', { id, markdown, cursor, renderCursor: true, history })
      }
    }
  },
  // Exchange from with to and move from to the end if to is null or empty.
  EXCHANGE_TABS_BY_ID (state, tabIDs) {
    const { fromId } = tabIDs
    const toId = tabIDs.toId // may be null

    const { tabs } = state
    const moveItem = (arr, from, to) => {
      if (from === to) return true
      const len = arr.length
      const item = arr.splice(from, 1)
      if (item.length === 0) return false

      arr.splice(to, 0, item[0])
      return arr.length === len
    }

    const fromIndex = tabs.findIndex(t => t.id === fromId)
    if (!toId) {
      moveItem(tabs, fromIndex, tabs.length - 1)
    } else {
      const toIndex = tabs.findIndex(t => t.id === toId)
      const realToIndex = fromIndex < toIndex ? toIndex - 1 : toIndex
      moveItem(tabs, fromIndex, realToIndex)
    }
  },
  LOAD_CHANGE (state, change) {
    const { tabs, currentFile } = state
    const { data, pathname } = change
    const { isMixedLineEndings, lineEnding, adjustLineEndingOnSave, encoding, markdown, filename } = data
    const options = { encoding, lineEnding, adjustLineEndingOnSave }
    const newFileState = getSingleFileState({ markdown, filename, pathname, options })
    if (isMixedLineEndings) {
      notice.notify({
        title: 'Line Ending',
        message: `${filename} has mixed line endings which are automatically normalized to ${lineEnding.toUpperCase()}.`,
        type: 'primary',
        time: 20000,
        showConfirm: false
      })
    }

    let fileState = null
    for (const tab of tabs) {
      if (tab.pathname === pathname) {
        const oldId = tab.id
        Object.assign(tab, newFileState)
        tab.id = oldId
        fileState = tab
        break
      }
    }

    if (!fileState) {
      throw new Error('LOAD_CHANGE: Cannot find tab in tab list.')
    }

    if (pathname === currentFile.pathname) {
      state.currentFile = fileState
      const { id, cursor, history } = fileState
      bus.$emit('file-changed', { id, markdown, cursor, renderCursor: true, history })
    }
  },
  SET_PATHNAME (state, file) {
    const { filename, pathname, id } = file
    if (id === state.currentFile.id && pathname) {
      window.DIRNAME = path.dirname(pathname)
    }

    const targetFile = state.tabs.filter(f => f.id === id)[0]
    if (targetFile) {
      const isSaved = true
      Object.assign(targetFile, { filename, pathname, isSaved })
    }
  },
  SET_SAVE_STATUS (state, status) {
    if (hasKeys(state.currentFile)) {
      state.currentFile.isSaved = status
    }
  },
  SET_SAVE_STATUS_WHEN_REMOVE (state, { pathname }) {
    state.tabs.forEach(f => {
      if (f.pathname === pathname) {
        f.isSaved = false
      }
    })
  },
  SET_MARKDOWN (state, markdown) {
    if (hasKeys(state.currentFile)) {
      state.currentFile.markdown = markdown
    }
  },
  SET_DOCUMENT_ENCODING (state, encoding) {
    if (hasKeys(state.currentFile)) {
      state.currentFile.encoding = encoding
    }
  },
  SET_LINE_ENDING (state, lineEnding) {
    if (hasKeys(state.currentFile)) {
      state.currentFile.lineEnding = lineEnding
    }
  },
  SET_ADJUST_LINE_ENDING_ON_SAVE (state, adjustLineEndingOnSave) {
    if (hasKeys(state.currentFile)) {
      state.currentFile.adjustLineEndingOnSave = adjustLineEndingOnSave
    }
  },
  SET_WORD_COUNT (state, wordCount) {
    if (hasKeys(state.currentFile)) {
      state.currentFile.wordCount = wordCount
    }
  },
  SET_CURSOR (state, cursor) {
    if (hasKeys(state.currentFile)) {
      state.currentFile.cursor = cursor
    }
  },
  SET_HISTORY (state, history) {
    if (hasKeys(state.currentFile)) {
      state.currentFile.history = history
    }
  },
  CLOSE_TABS (state, arr) {
    let tabIndex = 0
    arr.forEach(id => {
      const index = state.tabs.findIndex(f => f.id === id)
      const { pathname } = state.tabs.find(f => f.id === id)
      if (pathname) {
        // close tab and unwatch this file
        ipcRenderer.send('AGANI::file-watch', { pathname, watch: false })
      }

      state.tabs.splice(index, 1)
      if (state.currentFile.id === id) {
        state.currentFile = {}
        window.DIRNAME = ''
        if (arr.length === 1) {
          tabIndex = index
        }
      }
    })
    if (!state.currentFile.id && state.tabs.length) {
      state.currentFile = state.tabs[tabIndex] || state.tabs[tabIndex - 1] || state.tabs[0] || {}
      if (typeof state.currentFile.markdown === 'string') {
        const { id, markdown, cursor, history, pathname } = state.currentFile
        window.DIRNAME = pathname ? path.dirname(pathname) : ''
        bus.$emit('file-changed', { id, markdown, cursor, renderCursor: true, history })
      }
    }
  },
  RENAME_IF_NEEDED (state, { src, dest }) {
    const { tabs } = state
    tabs.forEach(f => {
      if (f.pathname === src) {
        f.pathname = dest
        f.filename = path.basename(dest)
      }
    })
  },

  // TODO: Remove "SET_GLOBAL_LINE_ENDING" because nowhere used.
  SET_GLOBAL_LINE_ENDING (state, ending) {
    state.lineEnding = ending
  }
}

const actions = {
  FORMAT_LINK_CLICK ({ commit }, { data, dirname }) {
    ipcRenderer.send('AGANI::format-link-click', { data, dirname })
  },

  LISTEN_SCREEN_SHOT ({ commit }) {
    ipcRenderer.on('mt::screenshot-captured', e => {
      bus.$emit('screenshot-captured')
    })
  },

  // image path auto complement
  ASK_FOR_IMAGE_AUTO_PATH ({ commit, state }, src) {
    const { pathname } = state.currentFile
    if (pathname) {
      let rs
      const promise = new Promise((resolve, reject) => {
        rs = resolve
      })
      const id = getUniqueId()
      ipcRenderer.once(`mt::response-of-image-path-${id}`, (e, files) => {
        rs(files)
      })
      ipcRenderer.send('mt::ask-for-image-auto-path', { pathname, src, id })
      return promise
    } else {
      return []
    }
  },

  SEARCH ({ commit }, value) {
    commit('SET_SEARCH', value)
  },

  SHOW_IMAGE_DELETION_URL ({ commit }, deletionUrl) {
    notice.notify({
      title: 'Image deletion URL',
      message: `Click to copy the deletion URL of the uploaded image to the clipboard (${deletionUrl}).`,
      showConfirm: true,
      time: 20000
    })
      .then(() => {
        clipboard.writeText(deletionUrl)
      })
  },

  REMOVE_FILE_IN_TABS ({ commit, dispatch }, file) {
    commit('REMOVE_FILE_WITHIN_TABS', file)
    // unwatch this file
    const { pathname } = file
    dispatch('ASK_FILE_WATCH', { pathname, watch: false })
  },

  EXCHANGE_TABS_BY_ID ({ commit }, tabIDs) {
    commit('EXCHANGE_TABS_BY_ID', tabIDs)
  },

  // need update line ending when change between windows.
  LISTEN_FOR_LINEENDING_MENU ({ commit, state, dispatch }) {
    ipcRenderer.on('AGANI::req-update-line-ending-menu', e => {
      dispatch('UPDATE_LINEENDING_MENU')
    })
  },

  // need update line ending when change between tabs
  UPDATE_LINEENDING_MENU ({ commit, state }) {
    const { lineEnding } = state.currentFile
    if (lineEnding) {
      ipcRenderer.send('AGANI::update-line-ending-menu', lineEnding)
    }
  },

  CLOSE_SINGLE_FILE ({ commit, state }, file) {
    const { id, pathname, filename, markdown } = file
    const options = getOptionsFromState(file)
    ipcRenderer.send('AGANI::save-close', [{ id, pathname, filename, markdown, options }], true)
  },

  // need pass some data to main process when `save` menu item clicked
  LISTEN_FOR_SAVE ({ commit, state, dispatch }) {
    ipcRenderer.on('AGANI::ask-file-save', () => {
      const { id, pathname, markdown } = state.currentFile
      const options = getOptionsFromState(state.currentFile)
      if (id) {
        ipcRenderer.send('AGANI::response-file-save', { id, pathname, markdown, options })
      }
    })
  },

  // need pass some data to main process when `save as` menu item clicked
  LISTEN_FOR_SAVE_AS ({ commit, state }) {
    ipcRenderer.on('AGANI::ask-file-save-as', () => {
      const { id, pathname, markdown } = state.currentFile
      const options = getOptionsFromState(state.currentFile)
      if (id) {
        ipcRenderer.send('AGANI::response-file-save-as', { id, pathname, markdown, options })
      }
    })
  },

  LISTEN_FOR_SET_PATHNAME ({ commit }) {
    ipcRenderer.on('AGANI::set-pathname', (e, file) => {
      commit('SET_PATHNAME', file)
    })
  },

  LISTEN_FOR_CLOSE ({ commit, state }) {
    ipcRenderer.on('AGANI::ask-for-close', e => {
      const unSavedFiles = state.tabs.filter(file => !file.isSaved)
        .map(file => {
          const { id, filename, pathname, markdown } = file
          const options = getOptionsFromState(file)
          return { id, filename, pathname, markdown, options }
        })

      if (unSavedFiles.length) {
        ipcRenderer.send('AGANI::response-close-confirm', unSavedFiles)
      } else {
        ipcRenderer.send('AGANI::close-window')
      }
    })
  },

  LISTEN_FOR_SAVE_CLOSE ({ commit, state }) {
    ipcRenderer.on('AGANI::save-all-response', (e, { err, data }) => {
      if (!err && Array.isArray(data)) {
        const toBeClosedTabs = [...state.tabs.filter(f => f.isSaved), ...data]
        commit('CLOSE_TABS', toBeClosedTabs)
      }
    })
    ipcRenderer.on('AGANI::save-single-response', (e, { err, data }) => {
      if (!err && Array.isArray(data) && data.length) {
        commit('CLOSE_TABS', data)
      }
    })
  },

  ASK_FOR_SAVE_ALL ({ commit, state }, isClose) {
    const unSavedFiles = state.tabs.filter(file => !(file.isSaved && /[^\n]/.test(file.markdown)))
      .map(file => {
        const { id, filename, pathname, markdown } = file
        const options = getOptionsFromState(file)
        return { id, filename, pathname, markdown, options }
      })
    if (unSavedFiles.length) {
      const EVENT_NAME = isClose ? 'AGANI::save-close' : 'AGANI::save-all'
      const isSingle = false
      ipcRenderer.send(EVENT_NAME, unSavedFiles, isSingle)
    } else if (isClose) {
      commit('CLOSE_TABS', state.tabs.map(f => f.id))
    }
  },

  LISTEN_FOR_MOVE_TO ({ commit, state }) {
    ipcRenderer.on('AGANI::ask-file-move-to', () => {
      const { id, pathname, markdown } = state.currentFile
      const options = getOptionsFromState(state.currentFile)
      if (!id) return
      if (!pathname) {
        // if current file is a newly created file, just save it!
        ipcRenderer.send('AGANI::response-file-save', { id, pathname, markdown, options })
      } else {
        // if not, move to a new(maybe) folder
        ipcRenderer.send('AGANI::response-file-move-to', { id, pathname })
      }
    })
  },

  LISTEN_FOR_RENAME ({ commit, state, dispatch }) {
    ipcRenderer.on('AGANI::ask-file-rename', () => {
      dispatch('RESPONSE_FOR_RENAME')
    })
  },

  RESPONSE_FOR_RENAME ({ commit, state }) {
    const { id, pathname, markdown } = state.currentFile
    const options = getOptionsFromState(state.currentFile)
    if (!id) return
    if (!pathname) {
      // if current file is a newly created file, just save it!
      ipcRenderer.send('AGANI::response-file-save', { id, pathname, markdown, options })
    } else {
      bus.$emit('rename')
    }
  },

  // ask for main process to rename this file to a new name `newFilename`
  RENAME ({ commit, state }, newFilename) {
    const { id, pathname, filename } = state.currentFile
    if (typeof filename === 'string' && filename !== newFilename) {
      const newPathname = path.join(path.dirname(pathname), newFilename)
      ipcRenderer.send('AGANI::rename', { id, pathname, newPathname })
    }
  },

  UPDATE_CURRENT_FILE ({ commit, state, dispatch }, currentFile) {
    commit('SET_CURRENT_FILE', currentFile)
    const { tabs } = state
    if (!tabs.some(file => file.id === currentFile.id)) {
      commit('ADD_FILE_TO_TABS', currentFile)
    }
  },

  // This events are only used during window creation.
  LISTEN_FOR_BOOTSTRAP_WINDOW ({ commit, state, dispatch }) {
    ipcRenderer.on('mt::bootstrap-window', (e, { markdown, filename, pathname, options }) => {
      const fileState = getSingleFileState({ markdown, filename, pathname, options })
      const { id } = fileState
      const { lineEnding } = options
      commit('SET_GLOBAL_LINE_ENDING', lineEnding)
      dispatch('INIT_STATUS', true)
      dispatch('UPDATE_CURRENT_FILE', fileState)
      bus.$emit('file-loaded', { id, markdown })
      commit('SET_LAYOUT', {
        rightColumn: 'files',
        showSideBar: false,
        showTabBar: false
      })
      dispatch('SET_LAYOUT_MENU_ITEM')
    })

    ipcRenderer.on('mt::bootstrap-blank-window', (e, { lineEnding, markdown: source }) => {
      const { tabs } = state
      const fileState = getBlankFileState(tabs, lineEnding, source)
      const { id, markdown } = fileState
      commit('SET_GLOBAL_LINE_ENDING', lineEnding)
      dispatch('INIT_STATUS', true)
      dispatch('UPDATE_CURRENT_FILE', fileState)
      bus.$emit('file-loaded', { id, markdown })
      commit('SET_LAYOUT', {
        rightColumn: 'files',
        showSideBar: false,
        showTabBar: false
      })
      dispatch('SET_LAYOUT_MENU_ITEM')
    })
  },

  // Open a new tab, optionally with content.
  LISTEN_FOR_NEW_TAB ({ dispatch }) {
    ipcRenderer.on('AGANI::new-tab', (e, markdownDocument, selectTab=true) => {
      // TODO: allow to add a tab without selecting it
      if (markdownDocument) {
        // Create tab with content.
        dispatch('NEW_TAB_WITH_CONTENT', markdownDocument)
      } else {
        // Fallback: create a blank tab
        dispatch('NEW_UNTITLED_TAB')
      }
    })

    ipcRenderer.on('mt::new-untitled-tab', (e, selectTab=true, markdownString='', ) => {
      // TODO: allow to add a tab without selecting it
      // Create a blank tab
      dispatch('NEW_UNTITLED_TAB', markdownString)
    })
  },

  LISTEN_FOR_CLOSE_TAB ({ commit, state, dispatch }) {
    ipcRenderer.on('AGANI::close-tab', e => {
      const file = state.currentFile
      if (!hasKeys(file)) return
      const { isSaved } = file
      if (isSaved) {
        dispatch('REMOVE_FILE_IN_TABS', file)
      } else {
        dispatch('CLOSE_SINGLE_FILE', file)
      }
    })
  },

  // Create a new  untitled tab optional with markdown string.
  NEW_UNTITLED_TAB ({ commit, state, dispatch }, markdownString) {
    dispatch('SHOW_TAB_VIEW', false)
    const { tabs, lineEnding } = state
    const fileState = getBlankFileState(tabs, lineEnding, markdownString)
    const { id, markdown } = fileState
    dispatch('UPDATE_CURRENT_FILE', fileState)
    bus.$emit('file-loaded', { id, markdown })
  },

  /**
   * Create a new tab from the given markdown document
   *
   * @param {*} context Store context
   * @param {IMarkdownDocumentRaw} markdownDocument Class that represent a markdown document
   */
  NEW_TAB_WITH_CONTENT ({ commit, state, dispatch }, markdownDocument) {
    if (!markdownDocument) {
      console.warn('Cannot create a file tab without a markdown document!')
      dispatch('NEW_UNTITLED_TAB')
      return
    }

    // Check if tab already exist and select existing tab if so.
    const { tabs } = state
    const { pathname } = markdownDocument
    const existingTab = tabs.find(t => isSameFileSync(t.pathname, pathname))
    if (existingTab) {
      dispatch('UPDATE_CURRENT_FILE', existingTab)
      return
    }

    dispatch('SHOW_TAB_VIEW', false)

    const { markdown, isMixedLineEndings } = markdownDocument
    const docState = createDocumentState(markdownDocument)
    const { id } = docState
    dispatch('UPDATE_CURRENT_FILE', docState)
    bus.$emit('file-loaded', { id, markdown })

    if (isMixedLineEndings) {
      const { filename, lineEnding } = markdownDocument
      notice.notify({
        title: 'Line Ending',
        message: `${filename} has mixed line endings which are automatically normalized to ${lineEnding.toUpperCase()}.`,
        type: 'primary',
        time: 20000,
        showConfirm: false
      })
    }
  },

  SHOW_TAB_VIEW ({ commit, state, dispatch }, always) {
    const { tabs } = state
    if (always || tabs.length <= 1) {
      commit('SET_LAYOUT', { showTabBar: true })
      dispatch('SET_LAYOUT_MENU_ITEM')
    }
  },

  // Content change from realtime preview editor and source code editor
  // WORKAROUND: id is "muya" if changes come from muya and not source code editor! So we don't have to apply the workaround.
  LISTEN_FOR_CONTENT_CHANGE ({ commit, state, rootState }, { id, markdown, wordCount, cursor, history, toc }) {
    const { autoSave } = rootState.preferences
    const { projectTree } = rootState.project
    const { id: currentId, pathname, markdown: oldMarkdown } = state.currentFile

    if (!id) {
      throw new Error(`Listen for document change but id was not set!`)
    } else if (!currentId || state.tabs.length === 0) {
      // Discard changes - this case should normally not occur.
      return
    } else if (id !== 'muya' && currentId !== id) {
      // WORKAROUND: We commit changes after switching the tab in source code mode.
      // Update old tab or discard changes
      for (const tab of state.tabs) {
        if (tab.id && tab.id === id) {
          tab.markdown = markdown
          // set cursor
          if (cursor) tab.cursor = cursor
          // set history
          if (history) tab.history = history
          break
        }
      }
      return
    }

    const options = getOptionsFromState(state.currentFile)
    commit('SET_MARKDOWN', markdown)

    // ignore new line which is added if the editor text is empty (#422)
    if (oldMarkdown.length === 0 && markdown.length === 1 && markdown[0] === '\n') {
      return
    }

    // set word count
    if (wordCount) commit('SET_WORD_COUNT', wordCount)
    // set cursor
    if (cursor) commit('SET_CURSOR', cursor)
    // set history
    if (history) commit('SET_HISTORY', history)
    // set toc
    if (toc) commit('SET_TOC', toc)

    // change save status/save to file only when the markdown changed!
    if (markdown !== oldMarkdown) {
      if (projectTree) {
        commit('UPDATE_PROJECT_CONTENT', { markdown, pathname })
      }
      if (pathname && autoSave) {
        ipcRenderer.send('AGANI::response-file-save', { id: currentId, pathname, markdown, options })
      } else {
        commit('SET_SAVE_STATUS', false)
      }
    }
  },

  SELECTION_CHANGE ({ commit }, changes) {
    const { start, end } = changes
    if (start.key === end.key && start.block.text) {
      const value = start.block.text.substring(start.offset, end.offset)
      commit('SET_SEARCH', {
        matches: [],
        index: -1,
        value
      })
    }

    ipcRenderer.send('AGANI::selection-change', changes)
  },

  SELECTION_FORMATS ({ commit }, formats) {
    ipcRenderer.send('AGANI::selection-formats', formats)
  },

  // listen for export from main process
  LISTEN_FOR_EXPORT_PRINT ({ commit, state }) {
    ipcRenderer.on('AGANI::export', (e, { type }) => {
      bus.$emit('export', type)
    })
    ipcRenderer.on('AGANI::print', e => {
      bus.$emit('print')
    })
  },

  EXPORT ({ commit, state }, { type, content, markdown }) {
    if (!hasKeys(state.currentFile)) return
    const { filename, pathname } = state.currentFile
    ipcRenderer.send('AGANI::response-export', { type, content, filename, pathname, markdown })
  },

  LINTEN_FOR_EXPORT_SUCCESS ({ commit }) {
    ipcRenderer.on('AGANI::export-success', (e, { type, filePath }) => {
      notice.notify({
        title: 'Export',
        message: `Export ${path.basename(filePath)} successfully`,
        showConfirm: true
      })
        .then(() => {
          shell.showItemInFolder(filePath)
        })
    })
  },

  PRINT_RESPONSE ({ commit }) {
    ipcRenderer.send('AGANI::response-print')
  },

  LINTEN_FOR_PRINT_SERVICE_CLEARUP ({ commit }) {
    ipcRenderer.on('AGANI::print-service-clearup', e => {
      bus.$emit('print-service-clearup')
    })
  },

  LINTEN_FOR_SET_LINE_ENDING ({ commit, state }) {
    ipcRenderer.on('AGANI::set-line-ending', (e, { lineEnding, ignoreSaveStatus }) => {
      const { lineEnding: oldLineEnding } = state.currentFile
      if (lineEnding !== oldLineEnding) {
        commit('SET_LINE_ENDING', lineEnding)
        commit('SET_ADJUST_LINE_ENDING_ON_SAVE', lineEnding !== 'lf')
        if (!ignoreSaveStatus) {
          commit('SET_SAVE_STATUS', false)
        }
      }
    })
  },

  LISTEN_FOR_FILE_CHANGE ({ commit, state, rootState }) {
    ipcRenderer.on('AGANI::update-file', (e, { type, change }) => {
      // TODO: Set `isSaved` to false.
      // TODO: A new "changed" notification from different files overwrite the old notification - the old notification disappears.
      if (type === 'unlink') {
        return notice.notify({
          title: 'File Removed on Disk',
          message: `${change.pathname} has been removed or moved to other place`,
          type: 'warning',
          time: 0,
          showConfirm: false
        })
      } else {
        const { autoSave } = rootState.preferences
        const { windowActive } = rootState
        const { filename } = change.data
        if (windowActive) return
        if (autoSave) {
          commit('LOAD_CHANGE', change)
        } else {
          notice.clear()
          notice.notify({
            title: 'File Changed on Disk',
            message: `${filename} has been changed on disk, do you want to reload it?`,
            showConfirm: true,
            time: 0
          })
            .then(() => {
              commit('LOAD_CHANGE', change)
            })
        }
      }
    })
  },

  ASK_FILE_WATCH ({ commit }, { pathname, watch }) {
    ipcRenderer.send('AGANI::file-watch', { pathname, watch })
  },

  ASK_FOR_IMAGE_PATH ({ commit }) {
    return ipcRenderer.sendSync('mt::ask-for-image-path')
  }
}

export default { state, mutations, actions }
