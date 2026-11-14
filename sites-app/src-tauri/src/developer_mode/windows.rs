use serde::Serialize;
use std::{io, mem::size_of, ptr::null_mut};
use windows_sys::Win32::{
    Foundation::{ERROR_INSUFFICIENT_BUFFER, ERROR_NO_MORE_ITEMS},
    System::EventLog::*,
};

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

unsafe fn read_wide(pointer: *const u16) -> String {
    if pointer.is_null() {
        return String::new();
    }
    // EvtRender returns a terminated string owned by its output buffer.
    let mut length = 0;
    while unsafe { *pointer.add(length) } != 0 {
        length += 1;
    }
    String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(pointer, length) })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Crash {
    at: u64,
    module: String,
    exception: String,
}

struct EventHandle(EVT_HANDLE);

impl EventHandle {
    fn new(handle: EVT_HANDLE) -> io::Result<Self> {
        if handle == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(Self(handle))
        }
    }
}

impl Drop for EventHandle {
    fn drop(&mut self) {
        unsafe { EvtClose(self.0) };
    }
}

pub(super) fn recent_crashes() -> Result<Vec<Crash>, String> {
    let query = wide("*[System[EventID=1000 and TimeCreated[timediff(@SystemTime) <= 172800000]] and EventData[Data[@Name='AppName']='life-strategy-library.exe']]");
    let result = EventHandle::new(unsafe {
        EvtQuery(
            0,
            wide("Application").as_ptr(),
            query.as_ptr(),
            (EvtQueryChannelPath | EvtQueryReverseDirection) as u32,
        )
    })
    .map_err(|error| format!("无法读取 Windows 应用事件：{error}"))?;
    let paths = [
        wide("Event/System/TimeCreated/@SystemTime"),
        wide("Event/EventData/Data[@Name='ModuleName']"),
        wide("Event/EventData/Data[@Name='ExceptionCode']"),
        wide("Event/EventData/Data[@Name='AppPath']"),
    ];
    let pointers = paths.each_ref().map(|path| path.as_ptr());
    let render = EventHandle::new(unsafe {
        EvtCreateRenderContext(
            pointers.len() as u32,
            pointers.as_ptr(),
            EvtRenderContextValues,
        )
    })
    .map_err(|error| error.to_string())?;
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let executable = executable.to_string_lossy();
    let mut crashes = Vec::new();
    for _ in 0..64 {
        let mut event = 0;
        let mut count = 0;
        if unsafe { EvtNext(result.0, 1, &mut event, 500, 0, &mut count) } == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_NO_MORE_ITEMS as i32) {
                break;
            }
            return Err(error.to_string());
        }
        let event = EventHandle(event);
        if let Some((crash, path)) =
            render_crash(&render, &event).map_err(|error| error.to_string())?
        {
            if path.eq_ignore_ascii_case(&executable) {
                crashes.push(crash);
            }
        }
    }
    Ok(crashes)
}

fn render_crash(render: &EventHandle, event: &EventHandle) -> io::Result<Option<(Crash, String)>> {
    let (mut bytes, mut count) = (0, 0);
    unsafe {
        EvtRender(
            render.0,
            event.0,
            EvtRenderEventValues,
            0,
            null_mut(),
            &mut bytes,
            &mut count,
        )
    };
    let error = io::Error::last_os_error();
    if error.raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32) || bytes > 64 * 1024 {
        return Err(error);
    }
    let mut values =
        vec![EVT_VARIANT::default(); (bytes as usize).div_ceil(size_of::<EVT_VARIANT>())];
    if unsafe {
        EvtRender(
            render.0,
            event.0,
            EvtRenderEventValues,
            bytes,
            values.as_mut_ptr().cast(),
            &mut bytes,
            &mut count,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if count != 4 || values.len() < 4 || values[0].Type != EvtVarTypeFileTime as u32 {
        return Ok(None);
    }
    let string = |index: usize| {
        let field = values[index];
        if field.Type == EvtVarTypeString as u32 {
            unsafe { read_wide(field.Anonymous.StringVal) }
        } else {
            String::new()
        }
    };
    const WINDOWS_TO_UNIX_TICKS: u64 = 116_444_736_000_000_000;
    let at =
        unsafe { values[0].Anonymous.FileTimeVal }.saturating_sub(WINDOWS_TO_UNIX_TICKS) / 10_000;
    Ok(Some((
        Crash {
            at,
            module: string(1),
            exception: string(2),
        },
        string(3),
    )))
}
