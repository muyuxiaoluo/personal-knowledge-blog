use serde::Serialize;
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

const PET_W: f64 = 126.;
const PET_H: f64 = 150.;
const GAP: f64 = 12.;
const HOME: (f64, f64) = (264., 167.);
const SMALLTALK: (f64, f64) = (176., 60.);

pub(super) fn remove_frame(pet: &WebviewWindow) {
    let _ = pet.set_shadow(false);
    #[cfg(windows)]
    if let Ok(hwnd) = pet.hwnd() {
        use windows::Win32::Graphics::Dwm::{
            DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_WINDOW_CORNER_PREFERENCE,
            DWMWCP_DONOTROUND,
        };
        let border = 0xfffffffeu32;
        unsafe {
            let _ =
                DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR, (&border as *const u32).cast(), 4);
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                (&DWMWCP_DONOTROUND as *const _ as *const u32).cast(),
                4,
            );
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Layout {
    pet_x: f64,
    pet_y: f64,
    bubble_x: f64,
    bubble_y: f64,
    bubble_width: f64,
    bubble_height: f64,
    tail_y: f64,
    bubble_left: bool,
}

struct Scene {
    placed: bool,
    visible: bool,
    expanded: bool,
    speech: bool,
    ignore_cursor: bool,
    layout: Layout,
    idle_index: usize,
    next_idle: Instant,
    next_mood_check: Instant,
    context: Option<usize>,
    mood: &'static str,
    mood_until: Instant,
    busy: bool,
    reduced_motion: bool,
}
impl Default for Scene {
    fn default() -> Self {
        let now = Instant::now();
        Self {
            placed: false,
            visible: false,
            expanded: false,
            speech: false,
            ignore_cursor: false,
            layout: Layout::default(),
            idle_index: 0,
            next_idle: now + Duration::from_secs(10),
            next_mood_check: now,
            context: None,
            mood: "idle",
            mood_until: now,
            busy: false,
            reduced_motion: false,
        }
    }
}
#[derive(Default)]
pub(crate) struct PetStage(Mutex<Scene>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Presentation {
    expanded: bool,
    speech: bool,
    layout: Layout,
    direction: i32,
    walking: bool,
    mood: &'static str,
}

impl Scene {
    fn presentation(&self) -> Presentation {
        Presentation {
            expanded: self.expanded,
            speech: self.speech,
            layout: self.layout,
            direction: 1,
            walking: false,
            mood: self.mood,
        }
    }
    fn emit(&self, pet: &WebviewWindow) {
        let _ = pet.emit("asaba-stage", self.presentation());
    }
    fn reset_idle(&mut self) {
        self.next_idle = Instant::now() + Duration::from_secs(30);
    }
}

#[derive(Clone, Copy)]
struct Area {
    left: f64,
    top: f64,
    width: f64,
    height: f64,
}

fn place(
    anchor: (f64, f64),
    area: Area,
    bubble: Option<(f64, f64)>,
    speech: bool,
) -> ((f64, f64), (f64, f64), Layout) {
    let right = area.left + area.width;
    let bottom = area.top + area.height;
    let px = anchor.0.clamp(area.left, (right - PET_W).max(area.left));
    let py = anchor.1.clamp(area.top, (bottom - PET_H).max(area.top));
    let Some((width, height)) = bubble else {
        return ((px, py), (PET_W, PET_H), Layout::default());
    };
    let left_room = px - area.left;
    let right_room = right - px - PET_W;
    let left = left_room >= width + GAP || left_room >= right_room;
    let bx = if left {
        px - width - GAP
    } else {
        px + PET_W + GAP
    }
    .clamp(area.left, (right - width).max(area.left));
    let by = (if speech { py + 8. } else { py + PET_H - height })
        .clamp(area.top, (bottom - height).max(area.top));
    let wx = px.min((bx - 6.).max(area.left));
    let wy = py.min((by - 6.).max(area.top));
    (
        (wx, wy),
        (
            (px + PET_W).max((bx + width + 6.).min(right)) - wx,
            (py + PET_H).max((by + height + 6.).min(bottom)) - wy,
        ),
        Layout {
            pet_x: px - wx,
            pet_y: py - wy,
            bubble_x: bx - wx,
            bubble_y: by - wy,
            bubble_width: width,
            bubble_height: height,
            bubble_left: left,
            tail_y: (py + PET_H * if speech { 0.32 } else { 0.52 } - by)
                .clamp(19., (height - 19.).max(19.)),
        },
    )
}

fn position(
    pet: &WebviewWindow,
    scene: &mut Scene,
    bubble: Option<(f64, f64)>,
) -> Result<(), String> {
    let current = pet.outer_position().map_err(|error| error.to_string())?;
    let previous_scale = pet.scale_factor().map_err(|error| error.to_string())?;
    let previous_x = current.x as f64 + scene.layout.pet_x * previous_scale;
    let previous_y = current.y as f64 + scene.layout.pet_y * previous_scale;
    let monitor = if scene.placed {
        pet.monitor_from_point(
            previous_x + PET_W * previous_scale / 2.,
            previous_y + PET_H * previous_scale / 2.,
        )
    } else {
        pet.cursor_position()
            .and_then(|cursor| pet.monitor_from_point(cursor.x, cursor.y))
    }
    .map_err(|error| error.to_string())?
    .or(pet.primary_monitor().map_err(|error| error.to_string())?)
    .ok_or("找不到浅羽所在的屏幕。")?;
    let scale = monitor.scale_factor();
    let work = monitor.work_area();
    let area = Area {
        left: work.position.x as f64 / scale,
        top: work.position.y as f64 / scale,
        width: work.size.width as f64 / scale,
        height: work.size.height as f64 / scale,
    };
    let anchor = if scene.placed {
        (previous_x / scale, previous_y / scale)
    } else {
        (
            area.left + area.width - PET_W - 18.,
            area.top + area.height - PET_H - 14.,
        )
    };
    let (origin, size, layout) = place(anchor, area, bubble, scene.speech && !scene.expanded);
    let dimensions = PhysicalSize::new(
        (size.0 * scale).round() as u32,
        (size.1 * scale).round() as u32,
    );
    if pet.inner_size().ok() != Some(dimensions) {
        pet.set_size(dimensions)
            .map_err(|error| error.to_string())?;
    }
    let origin = PhysicalPosition::new(
        (origin.0 * scale).round() as i32,
        (origin.1 * scale).round() as i32,
    );
    if current != origin {
        pet.set_position(origin)
            .map_err(|error| error.to_string())?;
    }
    scene.layout = layout;
    scene.placed = true;
    Ok(())
}

pub(super) fn show(
    pet: WebviewWindow,
    expanded: bool,
    visible: bool,
    dictate: bool,
) -> Result<(), String> {
    let app = pet.app_handle().clone();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let stage = handle.state::<PetStage>();
        let Ok(mut scene) = stage.0.lock() else {
            return;
        };
        let change = scene.expanded != expanded || !scene.placed || scene.speech;
        scene.expanded = expanded;
        scene.speech = false;
        scene.visible = visible;
        scene.reset_idle();
        if change {
            let _ = position(&pet, &mut scene, expanded.then_some(HOME));
        }
        if scene.ignore_cursor {
            let _ = pet.set_ignore_cursor_events(false);
            scene.ignore_cursor = false;
        }
        scene.emit(&pet);
        if visible {
            #[cfg(windows)]
            crate::developer_mode::record(if expanded {
                "pet_expanded"
            } else {
                "pet_shown"
            });
            let _ = pet.show();
            if expanded {
                let _ = pet.set_focus();
            }
        } else {
            #[cfg(windows)]
            crate::developer_mode::record("pet_hidden");
            let _ = pet.hide();
        }
        if dictate {
            let _ = pet.emit("asaba-voice-shortcut", ());
        }
    })
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn asaba_stage(
    window: WebviewWindow,
    width: Option<f64>,
    height: Option<f64>,
    busy: Option<bool>,
    reduced_motion: Option<bool>,
    speech: Option<bool>,
) -> Result<Presentation, String> {
    super::asaba::pet_window(&window)?;
    let app = window.app_handle().clone();
    let handle = app.clone();
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let result = (|| {
            let stage = handle.state::<PetStage>();
            let mut scene = stage.0.lock().map_err(|_| "浅羽状态暂不可用。")?;
            if let Some(busy) = busy {
                scene.busy = busy;
            }
            if let Some(reduced) = reduced_motion {
                scene.reduced_motion = reduced;
            }
            if scene.busy || scene.reduced_motion {
                scene.reset_idle();
            }
            if let Some(speech) = speech {
                let speech = speech && !scene.expanded && scene.visible && !scene.busy;
                if speech != scene.speech {
                    scene.speech = speech;
                    if !scene.expanded {
                        position(&window, &mut scene, speech.then_some(SMALLTALK))?;
                    }
                }
            }
            if let (true, Some(width), Some(height)) = (scene.expanded, width, height) {
                if width.is_finite() && height.is_finite() {
                    position(
                        &window,
                        &mut scene,
                        Some((width.clamp(180., 350.), height.clamp(68., 466.))),
                    )?;
                }
            }
            let presentation = scene.presentation();
            scene.emit(&window);
            Ok(presentation)
        })();
        let _ = send.send(result);
    })
    .map_err(|error| error.to_string())?;
    receive.await.map_err(|_| "浅羽窗口暂不可用。")?
}

#[cfg(windows)]
fn foreground_blocks_walk() -> bool {
    use windows_sys::Win32::UI::Shell::{
        SHQueryUserNotificationState, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
    };
    let mut state = 0;
    if unsafe { SHQueryUserNotificationState(&mut state) } >= 0
        && matches!(state, QUNS_RUNNING_D3D_FULL_SCREEN | QUNS_PRESENTATION_MODE)
    {
        return true;
    }
    let activity = crate::work_observer_screen::activity();
    !activity.available || activity.idle_seconds >= 180
}

fn collapsed_click_through(over_pet: bool, point: (f64, f64), size: (f64, f64)) -> bool {
    !over_pet && point.0 >= 0. && point.1 >= 0. && point.0 < size.0 && point.1 < size.1
}

#[cfg(windows)]
fn tick(app: &tauri::AppHandle) {
    let Some(pet) = app.get_webview_window("companion") else {
        return;
    };
    let stage = app.state::<PetStage>();
    let Ok(mut scene) = stage.0.lock() else {
        return;
    };
    if !scene.visible || !scene.placed {
        return;
    }
    let now = Instant::now();
    if now >= scene.next_mood_check {
        scene.next_mood_check = now + Duration::from_secs(1);
        let mood = super::asaba::pet_context(app);
        if let Some((window, expression)) = mood {
            if scene.context != Some(window) {
                scene.context = Some(window);
                scene.mood = expression;
                scene.mood_until = now + Duration::from_secs(5);
                scene.emit(&pet);
            }
        } else {
            scene.context = None;
        }
        if scene.mood != "idle" && now >= scene.mood_until {
            scene.mood = "idle";
            scene.emit(&pet);
        }
    }
    let (Ok(origin), Ok(scale), Ok(cursor)) = (
        pet.outer_position(),
        pet.scale_factor(),
        pet.cursor_position(),
    ) else {
        return;
    };
    let x = (cursor.x - origin.x as f64) / scale;
    let y = (cursor.y - origin.y as f64) / scale;
    let layout = scene.layout;
    let over_pet = ((x - layout.pet_x - PET_W / 2.) / (PET_W * 0.47)).powi(2)
        + ((y - layout.pet_y - PET_H / 2.) / (PET_H * 0.52)).powi(2)
        <= 1.;
    let ignore = if scene.expanded {
        // Keep the transparent corners around the two surfaces usable by the window underneath.
        let over_bubble = x >= layout.bubble_x - GAP
            && x <= layout.bubble_x + layout.bubble_width + GAP
            && y >= layout.bubble_y
            && y <= layout.bubble_y + layout.bubble_height;
        let inside = x >= 0.
            && y >= 0.
            && x < (layout.pet_x + PET_W).max(layout.bubble_x + layout.bubble_width + 6.)
            && y < (layout.pet_y + PET_H).max(layout.bubble_y + layout.bubble_height + 6.);
        inside && !over_pet && !over_bubble
    } else {
        // Smalltalk is passive. Its entire surface lets clicks through; the
        // character remains the only interactive surface while collapsed.
        pet.inner_size()
            .map(|size| {
                collapsed_click_through(
                    over_pet,
                    (x, y),
                    (size.width as f64 / scale, size.height as f64 / scale),
                )
            })
            .unwrap_or(false)
    };
    if scene.ignore_cursor != ignore {
        if pet.set_ignore_cursor_events(ignore).is_ok() {
            scene.ignore_cursor = ignore;
            crate::developer_mode::record(if ignore {
                "pet_click_through_on"
            } else {
                "pet_click_through_off"
            });
        }
    }
    if scene.expanded || scene.speech || scene.busy || scene.reduced_motion || over_pet {
        return;
    }
    if now < scene.next_idle {
        return;
    }
    scene.next_idle = now + Duration::from_secs(35);
    if foreground_blocks_walk() {
        return;
    }
    let moods = ["thinking", "blink", "stretch", "spin"];
    scene.mood = moods[scene.idle_index % moods.len()];
    scene.idle_index += 1;
    scene.mood_until = now + Duration::from_secs(if scene.mood == "blink" { 1 } else { 4 });
    scene.emit(&pet);
}

pub(crate) fn start(app: tauri::AppHandle) {
    #[cfg(windows)]
    tauri::async_runtime::spawn(async move {
        loop {
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || tick(&handle));
            tokio::time::sleep(Duration::from_millis(75)).await;
        }
    });
    #[cfg(not(windows))]
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bubble_keeps_character_anchor_and_switches_side_at_screen_edges() {
        let area = Area {
            left: -1200.,
            top: -100.,
            width: 1200.,
            height: 900.,
        };
        for (anchor, left) in [((-130., 640.), true), ((-1180., -90.), false)] {
            let (window, size, layout) = place(anchor, area, Some((320., 400.)), false);
            assert_eq!((window.0 + layout.pet_x, window.1 + layout.pet_y), anchor);
            assert_eq!(layout.bubble_left, left);
            assert!(window.0 >= area.left && window.1 >= area.top);
            assert!(window.0 + size.0 <= area.left + area.width);
            assert!(window.1 + size.1 <= area.top + area.height);
        }
    }

    #[test]
    fn passive_speech_preserves_anchor_and_stays_beside_the_head() {
        let area = Area {
            left: 0.,
            top: 0.,
            width: 1920.,
            height: 1080.,
        };
        for anchor in [(1780., 900.), (0., 0.)] {
            let (window, size, layout) = place(anchor, area, Some(SMALLTALK), true);
            assert_eq!((window.0 + layout.pet_x, window.1 + layout.pet_y), anchor);
            assert_eq!(window.1 + layout.bubble_y, anchor.1 + 8.);
            assert!(window.0 + size.0 <= area.width && window.1 + size.1 <= area.height);
            let (collapsed, _, _) = place(anchor, area, None, false);
            assert_eq!(collapsed, anchor);
        }
    }

    #[test]
    fn passive_speech_passes_clicks_but_does_not_leave_the_character_ignored() {
        let size = (320., 150.);
        assert!(collapsed_click_through(false, (50., 25.), size));
        assert!(!collapsed_click_through(true, (257., 80.), size));
        // Outside the window, restore normal hit testing before the next entry.
        assert!(!collapsed_click_through(false, (-10., 25.), size));
        assert!(!collapsed_click_through(false, (400., 25.), size));
    }
}
