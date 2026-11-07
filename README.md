# Screenshot page (userscript)
Userscript to make screenshot of the web page and save as an image and optionally as PDF with pagination.

To install this script you need browser addon such as [**Tampermonkey**](https://www.tampermonkey.net/)

## Technology
This is based on [**Media Recorder API**](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder) and [`getDisplayMedia()`](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia) support in your browser ([1](https://caniuse.com/mediarecorder), [2](https://caniuse.com/mdn-api_mediadevices_getdisplaymedia_prefercurrenttab_option) and [3](https://caniuse.com/mdn-api_mediadevices_getdisplaymedia_selfbrowsersurface_option)). Although it currently works in Chromium-based browsers (Chrome, Edge, Brave, etc.), Firefox, Safari, Opera, only in Chromium-based it is fully utilized and convenient to use. In Firefox/Safari/Opera you would need to find your tab from a list of Tabs, Windows and Monitors which may not be convenient *(because it display them all and with a lot of tabs it will take some time to find your tab)*, it still will work if you select correct tab. When in the future they implement missing API, using it will be more convenient.

# Settings

| Variable name | Description | Values | Default |
| ------------- | ----------- | ------ | ------- |
| `PERFORMANCE_WAIT_MS` | Depending on your PC and performance with your browser you set up this value to delay scrolling. Setting it too low and you will get duplicated frames. Adjust depending on your PC. | number | `250` |
| `FRAME_TIMEOUT_MS` | Similar value, but for a video frame. It works by scrolling down and capture video and if you get some long delay this mean that you cannot record frames in time and need to wait more. | number | `4_000` |
| `CAPTURE_HOTKEY` | Hotkey combination, like `Ctrl+Shift+Alt+Q`, see details for [hotkey names](https://developer.mozilla.org/en-US/docs/Web/API/UI_Events/Keyboard_event_code_values) | **string** with **hotkey** and **modifiers** separated by `+` | `Ctrl+Alt+P` |
| `OUTPUT_FORMAT` | Image formats, support is based on your browser. Some latest formats may not fully be supported now, but will be in the future. | `png`, `jpg`, `webp`, `jxl`, `avif` | `webp` |
| `OUTPUT_QUALITY` | Image quality (lossy formats) | `0.92` |
| `SAVE_PDF` | Save PDF pages alongside image | `true` / `false` | `true` |
| `PDF_SPLIT_BY_FULLSCREEN` | When saving PDF, split pages by Full screen height, e.g. `1920x1080` with OS bar *(~40px)* and browser header *(~64px)* will take screenshots at `1920x976`, but you may want to have a full page `1920x1080` instead, this will recut images for fullscreen presentations. | `true` / `false` | `true` |
