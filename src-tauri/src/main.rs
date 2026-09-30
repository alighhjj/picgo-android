// release 下不弹控制台窗口（Windows 专用，其他平台这行会被 cfg 掉）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    picgo_tutu_lib::run()
}
