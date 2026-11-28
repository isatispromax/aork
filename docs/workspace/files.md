# Workspace files

Ticket08 adds the public `WorkspaceService.files` contract and the replaceable `aork.workspace.files@1` view. The workspace plugin contributes that view into the default workbench's right region (`aork.workbench.inspector-tabs@1`); the region container and the file view are separately replaceable, and both use the same authenticated server interfaces. The Host and transport contain no Workspace paths, schemas or business rules.

Select an open Workspace to browse its directories in a lazily listed tree, search file names and paths as you type, open a file in the Preview panel, edit text in the editor pane, upload, download and create an empty text file — the shape of deepseek-harness's files page (`packages/client/ui-sidebar-files`; MIT). The URL fragment names the directory, file and page the editor shows, across a reload. File browsing neither registers Artifacts nor attributes existing files to an Agent. The editor pane displays source text only, including HTML, and never runs uploaded content. Showing a file for what it is — rendered, drawn, coloured — is the Preview panel's, described below. The tree itself is read-only, as dsh's is: it creates, renames and deletes nothing in a directory.

## Files view

**The search box** stands at the top of the view, always present, with 显示隐藏项 and — while there is text — 清空搜索 beside it.

**The header** under it names the Workspace's directory on the server — directories muted, the last part in the text's colour, the end kept and the start faded where it is cut — with 重新读取 and a 更多操作 menu at its end. The menu holds the root's actions, 新建文件, 上传文件 and 复制路径, the same ones a directory row's menu offers; the file chooser they open is kept out of sight and has no control of its own.

**The tree** is listed one level at a time: a directory is read when it is first opened, and read again in place whenever it is reopened or the view is re-read, keeping what it showed until the answer comes. Directories come first, then names in natural, case-insensitive order. An entry whose name begins with `.` is hidden until 显示隐藏项 is pressed; that choice is the Workspace's and is kept in the browser. A symlink, or any entry that is neither file nor directory, is listed greyed with its reason and cannot be opened. A level says what it holds: 正在读取…, 空目录, 隐藏项未显示, 条目太多，只显示了一部分。, or its failure with 重试. The file last opened is the tree's current file: its row carries `aria-current`, and the tree opens the directories above it and scrolls it into view once. An address naming a file (`file`) or a directory (`directory`) is answered the same way.

**Searching.** Text is searched 150 ms after the last keystroke, case-insensitively, in file names and Workspace-relative paths, over the whole Workspace whether or not the tree has opened a directory; a new text drops the answer to the one before. The search never enters version-control directories or `node_modules`, and dot entries only while hidden entries are shown. The matches replace the tree in the same scroll area, as a tree pruned to them with every level open and each occurrence in a name marked, under a count line; a directory among them leaves the search and opens in the tree. There is no content search, no fuzzy match and no exclusion settings.

**Opening a file.** A file's row opens the file with the installed panel type that declares `opensWith: 'preview'`, in a tab of its own; where none is installed the editor pane shows it instead.

**The row menu** — a secondary press, the ContextMenu key, Shift+F10, or the `···` at the row's end for a touch — offers 编辑, 下载 and 复制路径 for a file, and 新建文件, 上传文件到这里 and 复制路径 for a directory or the root. 复制路径 copies the path on the server. Escape closes the menu and hands focus back to the row.

**The editor pane** shows a file's numbered source, a page of 500 lines at a time within `FILE_LIMITS.textBytes`, and rewrites it through `workspace.text` with the revision it read. It is reached by 编辑 on a row, by a file just created, and by any file opened where no Preview is installed. Another file, or another page, ends an edit; 重新读取 leaves an edit in progress alone.

**What is kept.** The levels read, the open directories, the search text and the scroll position are held outside the component, per tab and per Workspace, so switching tabs and coming back lists nothing anew; they are dropped when the tab closes and are not kept across a reload. The arrow keys walk the rows, down from the search box into the first and back up to it.

## Public interfaces

`@aork/contracts/workspace` exports `WorkspaceFileService`, result types, `FILE_LIMITS` and `WORKSPACE_FILES`. Trusted server Plugins obtain `WorkspaceService` through the declared `aork.workspace@1` dependency. File service read and write methods return Promises; HTTP callbacks await their results. Browser Plugins use the generic `runtime.resource(name, parameters, bytes?)`: an omitted body reads; a supplied `Uint8Array`, including an empty array, explicitly writes. It never retries a write. Access loss aborts outstanding resources and rejects results from an old authentication generation.

The HTTP resource route is `GET` or `POST /api/resources/<name>?workspaceId=<stable-id>&...`. Parameters must be single bounded strings. All reads require the signed browser Cookie; writes also require the canonical Origin, CSRF header, current `X-Aork-Graph` and `Content-Type: application/octet-stream`. A supplied stale read graph is rejected too. Plugins receive only parameters, bytes and SDK request context, not a Fastify request/reply or driver.

| Resource | Method and parameters | Result |
| --- | --- | --- |
| `workspace.files` | GET, `path` (empty for root) | JSON directory entries and `truncated` |
| `workspace.search` | GET, `query`, optional `includeHidden` (`1` or `0`) | JSON filename/path matches, `visited`, `truncated` |
| `workspace.preview` | GET, `path`, optional `startLine`/`lines` | JSON source, line numbers, revision and editability |
| `workspace.file` | GET, `path` | Original download bytes |
| `workspace.file` | POST, `path` | Create-only upload; JSON path, size and revision |
| `workspace.text` | POST, `path`, optional `expectedRevision` | UTF-8 write; JSON path, size and revision |

Downloads always use `application/octet-stream`, attachment disposition, `nosniff` and sandbox CSP. Unknown formats can be downloaded. JSON metadata/previews have sandbox CSP too. The default UI creates download Blobs with the same binary MIME, and it shows active HTML as escaped React text — never an iframe or a workbench-origin document. The Preview panel is the one place a Workspace file is rendered, and it renders under the rules in [Preview](#preview).

The transfer limit is 8 MiB. Text read/write is limited to 256 KiB, with 1–500 lines per preview and a positive start line. A partial preview is not editable in the default UI. Text rejects invalid UTF-8 and NUL and preserves an existing UTF-8 byte-order mark. Directory listing returns at most 500 entries; search visits at most 5,000 entries, returns at most 200 matches and descends at most 32 levels. Both bound encoded entry data to 750 KiB and report truncation. The search never enters `.git`, `.hg`, `.svn`, `.bzr`, `.jj`, `.sl` or `node_modules`, and matches and descends dot entries only while `includeHidden` is given: the Files view sends it while hidden entries are shown, and a caller that omits it keeps seeing them. The listing of a directory is not narrowed by these rules. Search matches names/relative paths, not file contents. Directory handles are read incrementally and closed.

Missing paths, permissions, changed directories, invalid paths, binary previews, oversize data and stale editor revisions have explicit errors. Upload never overwrites an existing file. The editor sends the preview's SHA-256 revision, so an externally changed or deleted original returns `WORKSPACE_FILE_CHANGED`. File state is visible after refresh and Host restart through the actual directory.

## Directory and write boundaries

The workspace manifest declares `filesystem.read` and `filesystem.write`; the default profile explicitly grants both under the accepted05 mechanism. A missing grant rejects the proposed graph before importing entries and retains the prior valid profile. These declarations do not replace Workspace boundary rules and do not create an OS sandbox. Existing profiles must explicitly apply a current authorized profile before loading this updated Plugin.

Filesystem metadata, directory iteration, descriptor reads/writes/synchronization/close, publication and cleanup use asynchronous `node:fs/promises`, outside SQLite transactions. Slow storage does not block unrelated authentication or control requests.

Each operation resolves the saved requested root again and verifies the actual root, recursive scope, directory kind, inode and applicable server permissions. The recorded device number stays claim metadata only: macOS renumbers a volume's device across OS updates, so the live identity check never compares it, while the resolved path plus inode still refuse a moved, replaced or retargeted registered root. A moved, replaced or retargeted registered root is refused. Paths are relative with no absolute, parent, dot, empty, backslash or NUL components. Missing-leaf checks use no-follow lstat and accept only ENOENT; a dangling symlink remains an existing forbidden entry for upload, text write and final revalidation. All symlinks below the registered root are rejected, including aliases pointing back inside it. The root's originally authorized alias is usable only while it identifies the same saved actual directory. Regular reads use a no-follow descriptor and verify file identity and content facts before returning data. Special files are not read or written.

Every write goes through the single workspace-owned `withWritePermission(id, operation)` entry. It validates the open Workspace and read-write root, checks authoritative writer status, and holds an in-memory canonical directory reservation across the entire awaited operation. Same-root and ancestor/descendant reservations conflict even when registered as different Workspaces. After asynchronous root validation, overlap/authority checks and reservation run without an await so concurrent validations cannot both reserve. The permit is released only after the awaited operation and descriptor/temporary-file cleanup resolve or reject; it has no expiry timer. A disconnected browser does not imply that physical file work stopped and does not release the permit.

Ticket11 must register a synchronous `WorkspaceWriterParticipant` before starting any managed writers and use the same `withWritePermission` gate around real Claim acquisition. Its `inspect(workspace)` must inspect all overlapping authoritative claims, returning `unclaimed`, `blocked` or `unknown`; pending cancellation and unconfirmed termination must remain blocked/unknown. Before any lifecycle participant is installed, this slice explicitly knows that it has no managed-writer subsystem. Once a participant registers, a missing, throwing, invalid or disposed authority is unknown and denies writes. The interface does not fabricate a Run, durable Claim or TTL release. Claim reservation must hold this same in-flight gate around its short synchronous transaction. Run/MCP use will also need server-authenticated ownership context, so GUI writes deny a Run Claim while the authorized owning Run can use its own Claim. A browser-supplied Run ID must never act as that authority. Ticket11 may extend this provisional contract when real Run/Claim acquisition and tools use it. Ticket08's installed participant test verifies the public integration seam and an actual held asynchronous writer, not Run/process safety; actual Run/Claim recovery and stop verification remain ticket11.

Writes create a mode-0600 temporary regular file in the destination directory and asynchronously write and synchronize its bytes. After waiting they recheck current Workspace authorization, the registered path, destination kind and any expected editor revision. Create-only uploads publish with an atomic hard link and then remove the temporary name, so an entry inserted after the last inspection cannot be overwritten; filesystems without hard-link support return an error. Text replacement uses rename after the final checks. Failure before publication does not publish a success result and attempts to remove the temporary file. An external root relocation can prevent locating that temporary name for cleanup; directory registration still rejects the changed root. This is a filesystem operation, not an SQLite transaction: it creates no durable command receipt, event, Artifact or Agent attribution. A process failure after the filesystem change can leave the caller uncertain; clients must inspect the file rather than assume an automatic retry is safe. Filesystem failures do not create false database success. Replacing a text file creates a new inode with mode0600; other metadata is not preserved.

These checks coordinate trusted Aork writers and ordinary filesystem access. They do not prevent external programs from changing directories and do not provide an OS sandbox against a malicious same-user process racing path operations. Run/Claim safety, MCP authorization, Artifact registration, Git, Linux/remote deployment and backup/restore acceptance remain their own tickets.

The public concurrency regression launches the real Host under an external test-environment preload that delays both the former synchronous fsync and the current asynchronous FileHandle.sync while still invoking the underlying I/O. It proves an authenticated bootstrap completes while the upload remains pending. Additional cases abort the client while retaining the writer gate, change an editor revision, insert a dangling link, and insert a file between final inspection and create-only publication. These are environment conditions, not product test endpoints.

## Preview

The `preview` Plugin contributes the Preview panel type to the right region (`aork.workbench.inspector-tabs@1`, `multiple`, `opensWith: preview`): one tab per Workspace file, its path the tab's `content`, so the same file is never open twice. It is in the shape of deepseek-harness's document preview (`packages/client/ui-sidebar-documentpreview`; MIT). It adds no command and no resource: it reads files through the public `workspace.file` resource the workspace Plugin already serves and renders entirely in the browser.

**Where it opens from.** A file's row in the Files view opens it through the tab the region hands the view (`FilesViewContext.tab`): it calls `tab.open('preview', path)`, naming the trigger and no plugin. A link that names a file — `#preview=<path>` — opens it the same way, and a relative link inside a rendered Markdown document opens the file it names.

**What is offered.** `@aork/contracts/preview` holds the rules the Files view and the Preview share as pure logic: `UNPREVIEWABLE_SUFFIXES` — video, audio, archives and disk images, fonts, Office documents and spreadsheets, executables, libraries and databases — and `isPreviewable(path)`. Such a file is opened in the Preview all the same, where it is named — 该格式文件暂时无法预览 — without reading a byte; download stays available, there and in the Files view's row menu. Office documents and spreadsheets are not rendered and are downloaded instead.

**How a file is shown.** By its suffix, the longest match first and ignoring case, with every way a file can be shown listed under 打开方式 and the first chosen by default:

| Suffixes | Shown as |
| --- | --- |
| `md`, `markdown`, `mdown` | Markdown rendered, or its source |
| `html`, `htm`, `xhtml` | the page in a sandbox, or its source |
| `png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`, `ico`, `avif` | an image; `svg` also as its source |
| `pdf` | the browser's own viewer, or a notice and download where it has none |
| anything else that is text | source, coloured by `highlight.js` where a language is registered for the suffix, plain otherwise, with line numbers and a wrap toggle |

Text is UTF-8 without NUL and at most 256 KiB — the file service's own `FILE_LIMITS.textBytes` — and a transfer at most 8 MiB. Bytes shown as they are, an image or a PDF, are wrapped in a Blob under the type their suffix names, because the resource answers every file as a download.

**Trust boundary.** The page is served without a Content Security Policy, so nothing reaches it unsanitised.

- Markdown is rendered by `marked` and sanitised with DOMPurify before it is put in the page: active content is taken out, forms and embedded frames are not allowed, and every link opens in a tab of its own with no handle on this one. Where the sanitiser cannot run, nothing is rendered and the source stands in.
- An HTML file is rendered in a frame with `sandbox="allow-scripts"` and nothing more: an opaque origin, which can run the page's own scripts and can neither read the workbench's session nor act for the user, navigate the workbench on top of itself, open popups or submit forms. It is never given the same-origin grant and is never a workbench-origin document. Its source remains a view of its own.
- An SVG is drawn through an image element, where scripts do not run.
- Source is drawn as React text from the file's own characters, never as markup.

What a preview reads stays in the browser for as long as its tab is open and is dropped when the tab closes; 重新读取 reads the file again. A Markdown document's relative image references are not resolved against the Workspace and do not draw.

