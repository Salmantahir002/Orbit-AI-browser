# Browser menu and panels

## Phase 1: Native layering and window ownership

The toolbar menu opens an isolated, transparent `WebContentsView` above the website views. Its React entry point is `?surface=browser-overlay`. Menus, submenus, sheets, and dialogs render in this view, so a website cannot cover them. The website continues running and keeps its bounds while the overlay is open. The overlay remains attached during the exit animation, then becomes hidden and restores focus to the menu button.

Each browser window owns its tab views. Tab, scan, and agent-runtime IPC check both the trusted shell frame and tab ownership. Opening a new window creates a complete Orbit shell with its own tabs. Closing the last tab closes that window. Popup views continue adopting Electron-supplied `webContents` and sharing the opener's session.

## Phase 2: Menu, navigation, and saved browsing information

The menu includes New tab, New window, History, Downloads, Bookmarks, Delete browsing data, Zoom, Print, About Orbit, Settings, and Exit. History and Bookmarks have Chromium-style submenus. Standard Ctrl shortcuts work from the shell, guest pages, and the overlay; Alt+F opens the menu and F11 toggles full screen. History and bookmark managers support search, opening a page in a new tab, and deletion. Bookmarks also support adding and editing, and existing local-storage bookmarks migrate once into the shared profile.

History records successful main-frame navigation and page titles. The profile stores up to 10,000 visits and 500 finished download records while retaining active downloads. It lives in `browser-profile.json` under Electron's Orbit user-data directory, independently of provider credentials and website storage. All Orbit windows receive profile changes. Writes are debounced and saved through a temporary file and rename.

## Phase 3: Downloads and settings

Downloads use Electron's real `will-download`, `updated`, and `done` events. The download panel opens when a download starts and no other browser panel is open. A toolbar indicator provides access while downloads are active. The panel displays received and total bytes, progress, speed, estimated time, and completed, paused, interrupted, or cancelled status. Unknown download sizes use an indeterminate progress indicator.

Controls include pause, resume when supported, cancel, retry for reusable file URLs, open file, show in folder, and remove a finished record. Removing history does not delete downloaded files. Downloads default to the selected folder, avoid overwriting existing files, and optionally prompt for each save location. The picker is available in Downloads and Settings. Save Image As and Save Link As always request a location.

Settings also control bookmark-bar visibility and default page zoom. About reports the actual Orbit, Chromium, Electron, Node.js, and platform versions. Exit quits the application and flushes the profile.

The UI follows the shadcn neutral dark theme with Radix menu/dialog primitives, Lucide icons, and Framer Motion transitions. It supports focus trapping, Escape, keyboard menu navigation, labeled controls, and reduced-motion preferences. Overlay dependencies load separately from the welcome screen.

## Phase 4: Validation and limits

Run the feature suite with `npx playwright test e2e/browserMenu.spec.ts` from `frontend`, after `npm run electron:build` and a frontend build. The suite uses an isolated `ORBIT_USER_DATA_DIR` and a local HTTP server. It checks native view ordering and transparency, menu/submenu actions, native keyboard shortcuts, guest zoom, history search, bookmark edits, window isolation, download controls and saved bytes, duplicate filenames, folder/save preferences, data deletion, restart persistence, runtime versions, and Exit. OS dialog and file-opening APIs are mocked in automated tests; actual download events and files are used.

The existing `e2e/app.spec.ts` suite verifies startup, toolbar, assistant visibility, and popup sign-in behavior. Use a separate `ORBIT_USER_DATA_DIR` when running it to keep automated test data isolated.

Validated on 8 October 2026: the full `npm run build` completed successfully, including backend, renderer, and Electron TypeScript builds. All 14 tests passed in the combined `e2e/app.spec.ts` and `e2e/browserMenu.spec.ts` run. Targeted ESLint checks passed for the new controller, profile, types, overlay components, toolbar, and renderer entry point. Menu, Settings, and Downloads screenshots were inspected and saved under `frontend/artifacts/browser-menu`.

Electron does not expose time filters for deleting cookies, site storage, or cache through these session APIs. The time selector filters browsing and download history; site data and cache clear for all time. The dialog states this scope before deletion. Interrupted transfers from a previous app session can be retried; they are not advertised as resumable native transfers.

Native website views and the overlay each have their own screenshot surface. Capture the overlay renderer to inspect its UI; a shell renderer screenshot alone does not include the guest or overlay surfaces.
