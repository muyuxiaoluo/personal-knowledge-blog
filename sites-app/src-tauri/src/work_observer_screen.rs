#[derive(Clone, Default)]
pub(crate) struct DesktopActivity {
    pub title: String,
    pub application: String,
    pub idle_seconds: u32,
    pub available: bool,
    pub window: usize,
    pub process_id: u32,
    pub executable: String,
}

#[cfg(not(windows))]
pub(crate) fn activity() -> DesktopActivity {
    DesktopActivity::default()
}

#[cfg(not(windows))]
pub(crate) fn capture() -> Result<Vec<u8>, String> {
    Err("整屏采集目前支持 Windows。".into())
}

#[cfg(windows)]
pub(crate) fn activity() -> DesktopActivity {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::{StationsAndDesktops::*, SystemInformation::GetTickCount, Threading::*},
        UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
    };
    // A locked or secure input desktop must never be sampled.
    unsafe {
        let desktop = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
        if desktop.is_null() {
            return DesktopActivity::default();
        }
        let mut name = [0u16; 128];
        let mut needed = 0;
        let read_name = GetUserObjectInformationW(
            desktop,
            UOI_NAME,
            name.as_mut_ptr().cast(),
            std::mem::size_of_val(&name) as u32,
            &mut needed,
        ) != 0;
        let end = name
            .iter()
            .position(|value| *value == 0)
            .unwrap_or(name.len());
        let available =
            read_name && String::from_utf16_lossy(&name[..end]).eq_ignore_ascii_case("Default");
        CloseDesktop(desktop);
        if !available {
            return DesktopActivity::default();
        }
        let window = GetForegroundWindow();
        let mut title = [0u16; 512];
        let length = GetWindowTextW(window, title.as_mut_ptr(), title.len() as i32).max(0) as usize;
        let mut process_id = 0;
        GetWindowThreadProcessId(window, &mut process_id);
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
        let mut application = String::new();
        let mut executable = String::new();
        if !process.is_null() {
            let mut path = [0u16; 1024];
            let mut size = path.len() as u32;
            if QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut size) != 0 {
                executable = String::from_utf16_lossy(&path[..size as usize]);
                application =
                    std::path::Path::new(&executable)
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_default();
            }
            CloseHandle(process);
        }
        let mut input = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        let idle_seconds = if GetLastInputInfo(&mut input) != 0 {
            GetTickCount().wrapping_sub(input.dwTime) / 1000
        } else {
            u32::MAX
        };
        DesktopActivity {
            title: String::from_utf16_lossy(&title[..length]),
            application,
            idle_seconds,
            available,
            window: window as usize,
            process_id,
            executable,
        }
    }
}

#[cfg(windows)]
pub(crate) fn capture() -> Result<Vec<u8>, String> {
    use std::ptr::null_mut;
    use windows_sys::Win32::{Graphics::Gdi::*, UI::WindowsAndMessaging::*};
    struct Resources {
        screen: HDC,
        memory: HDC,
        bitmap: HBITMAP,
        previous: HGDIOBJ,
    }
    impl Drop for Resources {
        fn drop(&mut self) {
            unsafe {
                if !self.previous.is_null() && !self.memory.is_null() {
                    SelectObject(self.memory, self.previous);
                }
                if !self.bitmap.is_null() {
                    DeleteObject(self.bitmap);
                }
                if !self.memory.is_null() {
                    DeleteDC(self.memory);
                }
                if !self.screen.is_null() {
                    ReleaseDC(null_mut(), self.screen);
                }
            }
        }
    }
    unsafe {
        let width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if width <= 0 || height <= 0 || i64::from(width) * i64::from(height) > 40_000_000 {
            return Err("屏幕尺寸无法采集。".into());
        }
        let mut resources = Resources {
            screen: GetDC(null_mut()),
            memory: null_mut(),
            bitmap: null_mut(),
            previous: null_mut(),
        };
        if resources.screen.is_null() {
            return Err("无法读取桌面。".into());
        }
        resources.memory = CreateCompatibleDC(resources.screen);
        resources.bitmap = CreateCompatibleBitmap(resources.screen, width, height);
        if resources.memory.is_null() || resources.bitmap.is_null() {
            return Err("无法创建截图缓冲。".into());
        }
        resources.previous = SelectObject(resources.memory, resources.bitmap);
        if resources.previous.is_null() {
            return Err("无法准备截图缓冲。".into());
        }
        if BitBlt(
            resources.memory,
            0,
            0,
            width,
            height,
            resources.screen,
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            SRCCOPY | CAPTUREBLT,
        ) == 0
        {
            return Err("屏幕截图失败。".into());
        }
        // GetDIBits requires that the bitmap is no longer selected into a DC.
        SelectObject(resources.memory, resources.previous);
        resources.previous = null_mut();
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..std::mem::zeroed()
        };
        let mut pixels = vec![0u8; width as usize * height as usize * 4];
        if GetDIBits(
            resources.screen,
            resources.bitmap,
            0,
            height as u32,
            pixels.as_mut_ptr().cast(),
            &mut info,
            DIB_RGB_COLORS,
        ) != height
        {
            return Err("无法读取截图像素。".into());
        }
        // Keep the saved evidence at native resolution; Ollama handles its own image preprocessing.
        let rgb: Vec<u8> = pixels
            .chunks_exact(4)
            .flat_map(|p| [p[2], p[1], p[0]])
            .collect();
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, width as u32, height as u32);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.set_compression(png::Compression::Fast);
            encoder
                .write_header()
                .map_err(|error| error.to_string())?
                .write_image_data(&rgb)
                .map_err(|error| error.to_string())?;
        }
        Ok(bytes)
    }
}
