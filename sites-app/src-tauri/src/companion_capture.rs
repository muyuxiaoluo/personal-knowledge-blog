use windows::{
    core::{factory, Interface, Result},
    Graphics::{
        Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession},
        DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat},
    },
    Win32::{
        Foundation::HWND,
        Graphics::{Direct3D::D3D_DRIVER_TYPE_HARDWARE, Direct3D11::*, Dxgi::IDXGIDevice},
        System::WinRT::{
            Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess},
            Graphics::Capture::IGraphicsCaptureItemInterop,
            RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED,
        },
    },
};

pub(super) struct Frame {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

impl Frame {
    pub fn signature(&self) -> Vec<u8> {
        (0..16)
            .flat_map(|y| {
                (0..16).map(move |x| {
                    let offset =
                        ((self.height * y / 16 * self.width + self.width * x / 16) * 3) as usize;
                    ((self.pixels[offset] as u16
                        + self.pixels[offset + 1] as u16
                        + self.pixels[offset + 2] as u16)
                        / 3) as u8
                })
            })
            .collect()
    }

    pub fn png(&self) -> std::result::Result<Vec<u8>, String> {
        let mut bytes = Vec::new();
        let mut encoder = png::Encoder::new(&mut bytes, self.width, self.height);
        encoder.set_color(png::ColorType::Rgb);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer
            .write_image_data(&self.pixels)
            .map_err(|e| e.to_string())?;
        writer.finish().map_err(|e| e.to_string())?;
        Ok(bytes)
    }
}

pub(super) fn capture(window: usize) -> Result<Frame> {
    fn unavailable() -> windows::core::Error {
        windows::core::Error::new(
            windows::core::HRESULT(0x80004005_u32 as i32),
            "无法读取窗口画面",
        )
    }
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { RoUninitialize() };
        }
    }
    unsafe { RoInitialize(RO_INIT_MULTITHREADED)? };
    let _apartment = Apartment;
    if !GraphicsCaptureSession::IsSupported()? {
        return Err(unavailable());
    }
    let factory = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
    let item: GraphicsCaptureItem = unsafe { factory.CreateForWindow(HWND(window as _))? };
    let mut device = None;
    let mut context = None;
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            Default::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )?;
    }
    let device = device.ok_or_else(unavailable)?;
    let context = context.ok_or_else(unavailable)?;
    let dxgi = device.cast::<IDXGIDevice>()?;
    let winrt: IDirect3DDevice = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi)? }.cast()?;
    let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
        &winrt,
        DirectXPixelFormat::B8G8R8A8UIntNormalized,
        1,
        item.Size()?,
    )?;
    let session = pool.CreateCaptureSession(&item)?;
    let _ = session.SetIsCursorCaptureEnabled(false);
    let result = (|| {
        session.StartCapture()?;
        let start = std::time::Instant::now();
        let frame = loop {
            match pool.TryGetNextFrame() {
                Ok(frame) => break frame,
                Err(e) if start.elapsed().as_millis() >= 700 => return Err(e),
                Err(_) => std::thread::sleep(std::time::Duration::from_millis(20)),
            }
        };
        let size = frame.ContentSize()?;
        let access = frame.Surface()?.cast::<IDirect3DDxgiInterfaceAccess>()?;
        let texture: ID3D11Texture2D = unsafe { access.GetInterface()? };
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { texture.GetDesc(&mut desc) };
        let source_w = (size.Width.max(0) as u32).min(desc.Width);
        let source_h = (size.Height.max(0) as u32).min(desc.Height);
        if source_w == 0 || source_h == 0 {
            return Err(unavailable());
        }
        let scale = source_w.max(source_h).max(768);
        let width = (source_w * 768 / scale).max(1);
        let height = (source_h * 768 / scale).max(1);
        desc.Usage = D3D11_USAGE_STAGING;
        desc.BindFlags = 0;
        desc.MiscFlags = 0;
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
        let mut staging = None;
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        let mut pixels = Vec::with_capacity((width * height * 3) as usize);
        unsafe {
            device.CreateTexture2D(&desc, None, Some(&mut staging))?;
            let staging = staging.ok_or_else(unavailable)?;
            context.CopyResource(&staging, &texture);
            context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
            for y in 0..height {
                let row = (y * source_h / height * mapped.RowPitch) as usize;
                for x in 0..width {
                    let offset = row + (x * source_w / width * 4) as usize;
                    let pixel = mapped.pData.cast::<u8>().add(offset);
                    pixels.extend_from_slice(&[*pixel.add(2), *pixel.add(1), *pixel]);
                }
            }
            context.Unmap(&staging, 0);
        }
        Ok(Frame {
            width,
            height,
            pixels,
        })
    })();
    let _ = session.Close();
    let _ = pool.Close();
    result
}
