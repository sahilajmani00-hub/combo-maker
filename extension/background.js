/**
 * The extension is only a viewer, so the worker does one thing: make the
 * toolbar button open the side panel instead of a popup.
 */

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('Could not set panel behaviour:', error))
