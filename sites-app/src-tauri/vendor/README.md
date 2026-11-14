# Tao 0.35.3

This is the crates.io source for Tao 0.35.3 (crate SHA-256 `d1c93047acf68669466a34690ac58cca7010bd1b201e1ec86f1fd0a75d3dd4a9`), with the Windows paint re-entry fix from [Tao PR #1410](https://github.com/tauri-apps/tao/pull/1410) backported to `src/platform_impl/windows/event_loop.rs`.

The workbench crashed while idle with exit code 101 and the assertion at the thread event target's `WM_PAINT` handler. A nested paint can arrive while an outer paint flush is still running. When the nested flush returns false, the outer flush remains responsible for completing the redraw and processing control flow.

Remove the local Cargo patch when the Tauri runtime dependency can use a Tao release that includes this fix.
