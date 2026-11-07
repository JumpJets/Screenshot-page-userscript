// ==UserScript==
// @name         Screenshot page
// @namespace    https://github.com/JumpJets/Screenshot-page-userscript
// @version      2026.11.07
// @description  Screenshot page and create PDF with pagination
// @author       X4
// @require      https://unpkg.com/jspdf@latest/dist/jspdf.umd.min.js
// @match        *://*/*
// @grant        none
// ==/UserScript==

(() => {
	"use strict";

	// ! User settings
	// ? If PC performance is low, increase this value to guarantee screenshots without overlap
	const PERFORMANCE_WAIT_MS = 250,
		FRAME_TIMEOUT_MS = 4_000,
		// ? Hotkey combination, like Ctrl+Shift+Alt+Q
		// See details: https://developer.mozilla.org/en-US/docs/Web/API/UI_Events/Keyboard_event_code_values
		CAPTURE_HOTKEY = "Ctrl+Alt+P",
		// ? Image formats, like: png, jpeg, webp, jxl, avif
		OUTPUT_FORMAT = "webp",
		// ? Image quality
		OUTPUT_QUALITY = 0.92,
		// ? Save PDF pages alongside image: true / false
		SAVE_PDF = true,
		// ? When saving PDF, split pages by Full screen height: true / false
		// e.g. 1920x1080 with OS bar (~40px) and browser header (~64px) will take screenshots at 1920x976
		// but you may want to have a full page 1920x1080 instead, this will recut images for fullscreen presentations.
		PDF_SPLIT_BY_FULLSCREEN = true;

	// ! Code section
	const SAFE_MAX_CANVAS_PIXELS = 50_000_000,
		IMAGE_FORMATS = {
			png: { mime_type: "image/png", extension: "png", max_size: 2_147_483_647 },
			jpeg: { mime_type: "image/jpeg", extension: "jpg", max_size: 65_535 },
			jpg: { mime_type: "image/jpeg", extension: "jpg", max_size: 65_535 },
			webp: { mime_type: "image/webp", extension: "webp", max_size: 16_383 },
			jxl: { mime_type: "image/jxl", extension: "jxl", max_size: 1_073_741_824 },
			avif: { mime_type: "image/avif", extension: "avif", max_size: 65_536 },
		};

	/** Normalize a KeyboardEvent code or shortcut key for comparison.
	 * @param {string} key KeyboardEvent.code value or configured key.
	 * @returns {string} Normalized key identifier.
	 */
	const normalize_hotkey_key = (key) => {
		if (key === "Space") return " ";
		if (/^Key[A-Z]$/.test(key) || /^Digit\d$/.test(key)) return key.slice(-1).toLowerCase();
		return key.toLowerCase();
	};

	/** Parse a configured shortcut into its key and modifier requirements.
	 * @param {string} shortcut Plus-separated key combination.
	 * @returns {{key: string, ctrl: boolean, alt: boolean, shift: boolean, meta: boolean}}
	 * @throws {Error} If a modifier is unknown or the shortcut has no key.
	 */
	const parse_hotkey = (shortcut) => {
		const parts = shortcut.split("+").map(part => part.trim()).filter(Boolean),
			key = parts.pop(),
			modifiers = parts.map(part => part.toLowerCase()),
			known_modifiers = new Set(["ctrl", "control", "alt", "shift", "meta", "cmd", "command"]);

		if (!key || modifiers.some(modifier => !known_modifiers.has(modifier))) throw new Error(`Invalid CAPTURE_HOTKEY: ${shortcut}`);

		return {
			key: normalize_hotkey_key(key),
			ctrl: modifiers.some(modifier => modifier === "ctrl" || modifier === "control"),
			alt: modifiers.includes("alt"),
			shift: modifiers.includes("shift"),
			meta: modifiers.some(modifier => modifier === "meta" || modifier === "cmd" || modifier === "command")
		};
	};

	const capture_hotkey_config = parse_hotkey(CAPTURE_HOTKEY);

	/** Create and initialize a DOM element, optionally applying callbacks.
	 * @param {string} tag Element tag name.
	 * @param {Record<string, any>} [attrs] Properties to assign to the element.
	 * @param {Record<string, any>} [callbacks] Element methods and arguments to invoke.
	 * @returns {HTMLElement} The initialized element.
	 */
	const create_element = (tag, attrs, callbacks) => attrs ? callbacks ? ((e) => { Object.entries(callbacks).forEach(([k, v]) => Array.isArray(v) ? e?.[k]?.(...v) : e?.[k]?.(v)); return e })(Object.assign(document.createElement(tag), attrs)) : Object.assign(document.createElement(tag), attrs) : document.createElement(tag);

	/** Probe supported canvas heights, respecting the configured output format limit.
	 * @returns {number} Largest tested height that can be drawn to and read back.
	 * @throws {Error} If none of the candidate heights is supported.
	 */
	const probe_canvas_max_height = () => {
		const output_format_max_size = IMAGE_FORMATS?.[OUTPUT_FORMAT]?.max_size ?? 2_147_483_647,
			candidates = [131_071, 65_535, 32_767, 16_384, 16_383, 8_192, 4_096].filter(sz => sz <= output_format_max_size);

		for (const height of candidates) {
			const canvas = create_element("canvas", { width: 1, height });
			try {
				const context = canvas.getContext("2d");
				if (canvas.width !== 1 || canvas.height !== height || !context) continue;

				context.fillStyle = "#00ff00";
				context.fillRect(0, 0, 1, 1);
				context.fillRect(0, height - 1, 1, 1);
				const first_pixel = context.getImageData(0, 0, 1, 1).data;
				const last_pixel = context.getImageData(0, height - 1, 1, 1).data;
				if (first_pixel[1] === 255 && first_pixel[3] === 255 && last_pixel[1] === 255 && last_pixel[3] === 255) {
					return height;
				}
			} catch {
				// * Try a smaller canvas after an allocation or readback failure.
			} finally {
				canvas.width = 1;
				canvas.height = 1;
			}
		}

		throw new Error("No supported canvas height candidate was found.");
	};

	/** Wait for two animation frames so layout and paint can settle.
	 * @returns {Promise<void>} Resolves after the next two animation frames.
	 */
	const wait_for_paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

	/** Wait for fresh screen-capture video frames and a minimum settling interval.
	 * @param {HTMLVideoElement} video Video element backed by the capture stream.
	 * @param {number} [count=2] Number of fresh frames to wait for.
	 * @returns {Promise<void>} Resolves when the stream is ready for sampling.
	 * @throws {Error} If no new video frame arrives before the timeout.
	 */
	const wait_for_video_frames = async (video, count = 2) => {
		const started_at = performance.now();
		if (!video.requestVideoFrameCallback) {
			await new Promise(resolve => setTimeout(resolve, PERFORMANCE_WAIT_MS));
			return;
		}

		for (let index = 0; index < count; index++) {
			await new Promise((resolve, reject) => {
				let callback_id;
				const timeout_id = setTimeout(() => {
					video.cancelVideoFrameCallback?.(callback_id);
					reject(new Error("Timed out waiting for a fresh captured frame."));
				}, FRAME_TIMEOUT_MS);

				callback_id = video.requestVideoFrameCallback(() => {
					clearTimeout(timeout_id);
					resolve();
				});
			});
		}
		const remaining_wait = PERFORMANCE_WAIT_MS - (performance.now() - started_at);
		if (remaining_wait > 0) await new Promise(resolve => setTimeout(resolve, remaining_wait));
	};

	/** Get the scrollable document height in CSS pixels.
	 * @param {HTMLElement} root Document root element.
	 * @returns {number} Current document height.
	 */
	const get_document_height = (root) => {
		const scrolling_element = document.scrollingElement || root;
		return Math.max(scrolling_element.scrollHeight, scrolling_element.clientHeight, window.innerHeight);
	};

	/** Hide likely fixed or sticky top navigation elements and remember their styles.
	 * @param {Map<Element, {value: string, priority: string}>} hidden_navbars Elements already hidden by this capture.
	 * @returns {void}
	 */
	const hide_sticky_navbars = (hidden_navbars) => {
		const top_region = window.innerHeight * 0.25;
		const minimum_width = Math.min(window.innerWidth * 0.4, 320);

		for (const element of document.body.querySelectorAll("*")) {
			if (hidden_navbars.has(element)) continue;

			const computed_style = getComputedStyle(element);
			if (computed_style.position !== "fixed" && computed_style.position !== "sticky") continue;
			if (computed_style.display === "none" || computed_style.visibility === "hidden") continue;

			const rect = element.getBoundingClientRect();
			if (rect.top >= top_region || rect.bottom <= 0) continue;
			if (rect.height < 24 || rect.height > window.innerHeight * 0.35) continue;

			const is_semantic_navbar = element.matches("header, nav, [role='banner'], [role='navigation']");
			if (!is_semantic_navbar && rect.width < minimum_width) continue;

			hidden_navbars.set(element, {
				value: element.style.getPropertyValue("visibility"),
				priority: element.style.getPropertyPriority("visibility")
			});
			element.style.setProperty("visibility", "hidden", "important");
		}
	};

	/** Create a stateful exporter that assembles canvas strips into PDF pages.
	 * @param {number} canvas_width Page width in source pixels.
	 * @param {number} page_height PDF page height in source pixels.
	 * @returns {{append_part: (canvas: HTMLCanvasElement) => void, finish: () => object|undefined}} PDF exporter operations.
	 */
	const create_pdf_exporter = (canvas_width, page_height) => {
		let pdf, page_canvas, page_context, page_rows = 0;

		/** Encode the current PDF page, cropping its final partial page if needed.
		 * @param {number} height Number of populated source rows.
		 * @param {HTMLCanvasElement} [source_canvas] Canvas containing page pixels.
		 * @returns {void}
		 */
		const flush_page = (height, source_canvas = page_canvas) => {
			if (!source_canvas || height <= 0) return;

			let export_canvas = source_canvas;

			if (height < source_canvas.height) {
				export_canvas = create_element("canvas", { width: canvas_width, height });
				const export_context = export_canvas.getContext("2d");

				if (!export_context) throw new Error("Cannot create cropped PDF page canvas context.");

				export_context.drawImage(source_canvas, 0, 0, canvas_width, height, 0, 0, canvas_width, height);
			}

			const pdf_width = canvas_width * 0.75,
				pdf_height = height * 0.75,
				format = [pdf_width, pdf_height],
				orientation = pdf_width >= pdf_height ? "landscape" : "portrait",
				image_data = export_canvas.toDataURL("image/jpeg", OUTPUT_QUALITY);

			if (!pdf) {
				const JsPDF = globalThis.jspdf?.jsPDF || globalThis.jsPDF;

				if (!JsPDF) throw new Error("jsPDF failed to load; check the userscript @require dependency.");

				pdf = new JsPDF({ unit: "pt", format, orientation, compress: true });
			} else {
				pdf.addPage(format, orientation);
			}

			pdf.addImage(image_data, "JPEG", 0, 0, pdf_width, pdf_height, `page-${pdf.getNumberOfPages()}`, "FAST");

			page_canvas = undefined;
			page_context = undefined;
			page_rows = 0;
		};

		/** Append an image part, splitting it across PDF pages as configured.
		 * @param {HTMLCanvasElement} source_canvas Completed image canvas part.
		 * @returns {void}
		 */
		const append_part = (source_canvas) => {
			if (!SAVE_PDF) return;

			let source_y = 0;

			while (source_y < source_canvas.height) {
				if (!page_canvas) {
					page_canvas = create_element("canvas", { width: canvas_width, height: page_height });
					page_context = page_canvas.getContext("2d");

					if (!page_context) throw new Error("Cannot create PDF page canvas context.");
				}

				const rows_to_copy = Math.min(page_height - page_rows, source_canvas.height - source_y);
				page_context.drawImage(source_canvas, 0, source_y, canvas_width, rows_to_copy, 0, page_rows, canvas_width, rows_to_copy);
				source_y += rows_to_copy;
				page_rows += rows_to_copy;
				if (page_rows === page_height) flush_page(page_rows);
			}
		};

		/** Flush the last partial PDF page and return the generated document.
		 * @returns {object|undefined} Generated jsPDF document, if PDF saving is enabled.
		 */
		const finish = () => {
			if (SAVE_PDF) flush_page(page_rows);
			return pdf;
		};

		return { append_part, finish };
	};

	/** Create a stateful assembler for full-page image canvas parts.
	 * @param {HTMLVideoElement} video Source stream video.
	 * @param {number} canvas_width Output image width in pixels.
	 * @param {number} max_part_height Maximum height of one image canvas.
	 * @param {{mime_type: string, extension: string}} image_format Requested output image format.
	 * @param {{append_part: Function}} pdf_exporter PDF page assembler.
	 * @param {number} initial_height Estimated full-page image height.
	 * @returns {object} Operations for drawing rows, resizing, trimming, and exporting parts.
	 */
	const create_image_assembler = (video, canvas_width, max_part_height, image_format, pdf_exporter, initial_height) => {
		let canvas_height = initial_height,
			canvas,
			context,
			part_index = 0;
		const completed_parts = [];

		/** Allocate or grow the current image-part canvas.
		 * @param {number} height Required canvas height.
		 * @returns {void}
		 */
		const ensure_canvas = (height) => {
			if (canvas?.height >= height) return;

			const expanded_canvas = create_element("canvas", {
					width: canvas_width,
					height: Math.min(max_part_height, height)
				}),
				expanded_context = expanded_canvas.getContext("2d");

			if (!expanded_context) throw new Error("Cannot create canvas context.");

			if (canvas) expanded_context.drawImage(canvas, 0, 0);
			canvas = expanded_canvas;
			context = expanded_context;
		};

		/** Encode and store the current image part, then advance the part index.
		 * @returns {Promise<void>}
		 * @throws {Error} If the browser cannot encode the requested image format.
		 */
		const export_current_part = async () => {
			if (!canvas) return;
			pdf_exporter.append_part(canvas);

			const blob = await new Promise(resolve => canvas.toBlob(resolve, image_format.mime_type, OUTPUT_QUALITY));

			if (!blob) throw new Error(`Browser could not encode ${OUTPUT_FORMAT.toUpperCase()}.`);
			if (blob.type !== image_format.mime_type) throw new Error(`This browser cannot encode ${OUTPUT_FORMAT.toUpperCase()}.`);

			completed_parts.push(blob);
			canvas = undefined;
			context = undefined;
			part_index++;
		};

		/** Copy video rows into the correct image parts, exporting full parts as needed.
		 * @param {number} source_top First source row in the video frame.
		 * @param {number} destination_top First destination row in the full-page image.
		 * @param {number} row_count Number of rows to copy.
		 * @returns {Promise<void>}
		 */
		const draw_video_rows = async (source_top, destination_top, row_count) => {
			let rows_drawn = 0;
			while (rows_drawn < row_count) {
				const absolute_top = destination_top + rows_drawn,
					next_part_index = Math.floor(absolute_top / max_part_height);
				if (next_part_index !== part_index) await export_current_part();

				const part_top = part_index * max_part_height,
					part_height = Math.min(max_part_height, canvas_height - part_top),
					local_top = absolute_top - part_top,
					rows_in_part = Math.min(row_count - rows_drawn, part_height - local_top);

				ensure_canvas(part_height);
				context.drawImage(
					video,
					0,
					source_top + rows_drawn,
					video.videoWidth,
					rows_in_part,
					0,
					local_top,
					canvas_width,
					rows_in_part
				);
				rows_drawn += rows_in_part;
			}
		};

		/** Update the estimated full-page height after lazy content loads.
		 * @param {number} height New full-page canvas height.
		 * @returns {void}
		 */
		const set_height = (height) => {
			canvas_height = height;
		};

		/** Trim the current image part to a reachable final document height.
		 * @param {number} height Final full-page height in output pixels.
		 * @returns {void}
		 */
		const trim_to_height = (height) => {
			canvas_height = height;
			const current_part_height = height - part_index * max_part_height;
			if (!canvas || current_part_height <= 0 || current_part_height >= canvas.height) return;

			const trimmed_canvas = create_element("canvas", { width: canvas_width, height: current_part_height }),
				trimmed_context = trimmed_canvas.getContext("2d");
			if (!trimmed_context) throw new Error("Cannot create trimmed canvas context.");
			trimmed_context.drawImage(canvas, 0, 0, canvas_width, current_part_height, 0, 0, canvas_width, current_part_height);
			canvas = trimmed_canvas;
			context = trimmed_context;
		};

		/** Export the final partial image part and return all encoded image blobs.
		 * @returns {Promise<Blob[]>} Encoded image parts.
		 */
		const finish = async () => {
			await export_current_part();
			return completed_parts;
		};

		return { draw_video_rows, finish, set_height, trim_to_height };
	};

	/** Capture, scroll, assemble, and download the current page as images and optional PDF.
	 * @returns {Promise<void>}
	 */
	const capture = async () => {
		let stream, video;
		const hidden_navbars = new Map(); // ? Hide sites sticky navbars
		const root = document.documentElement,
			original_scroll_y = window.scrollY,
			original_scroll_behavior = root.style.scrollBehavior,
			original_scrollbar_color = root.style.scrollbarColor,
			original_scrollbar_width = root.style.scrollbarWidth,
			original_pointer_events = root.style.pointerEvents,
			original_cursor = root.style.cursor;

		try {
			if (!navigator.mediaDevices?.getDisplayMedia) {
				throw new Error("Browser does not support capturing browser tabs.");
			}

			stream = await navigator.mediaDevices.getDisplayMedia({
				video: { displaySurface: "browser" },
				audio: false,
				preferCurrentTab: true,
				monitorTypeSurfaces: "exclude",
				surfaceSwitching: "exclude",
				systemAudio: "exclude",
				windowAudio: "exclude",
			});

			const track = stream.getVideoTracks()[0];
			if (track.getSettings().displaySurface && track.getSettings().displaySurface !== "browser") {
				throw new Error("In the popup prompt select browser tab instead of browser window or monitor.");
			}

			video = create_element("video", { muted: true, playsInline: true, srcObject: stream });
			await video.play();

			await wait_for_video_frames(video);

			root.style.scrollBehavior = "auto";
			root.style.scrollbarColor = "transparent transparent";
			root.style.scrollbarWidth = "none";
			root.style.pointerEvents = "none";
			root.style.cursor = "none";

			window.scrollTo(0, 0);
			await wait_for_paint();
			await wait_for_video_frames(video);

			let document_height = get_document_height(root);
			window.scrollTo(0, Number.MAX_SAFE_INTEGER);
			await wait_for_paint();
			await wait_for_video_frames(video);
			document_height = get_document_height(root);

			const max_scroll_y = window.scrollY;
			const viewport_height = Math.min(window.innerHeight, document_height - max_scroll_y);
			if (viewport_height <= 0) throw new Error("Cannot determine the visible page height.");

			window.scrollTo(0, 0);
			await wait_for_paint();
			await wait_for_video_frames(video);

			const scale_y = video.videoWidth / window.innerWidth,
				canvas_width = video.videoWidth,
				image_format = IMAGE_FORMATS[OUTPUT_FORMAT];
			if (!image_format) throw new Error(`Unknown output format: ${OUTPUT_FORMAT}`);

			const detected_canvas_max_height = probe_canvas_max_height();
			const max_part_height = Math.min(detected_canvas_max_height, Math.floor(SAFE_MAX_CANVAS_PIXELS / canvas_width));

			console.debug("[Screenshot page] capture dimensions", {
				layout_viewport_height: window.innerHeight,
				content_viewport_height: viewport_height,
				max_scroll_y,
				document_height,
				detected_canvas_max_height,
				max_part_height,
				max_part_pixels: canvas_width * max_part_height,
				root_client_height: root.clientHeight,
				visual_viewport_height: window.visualViewport?.height,
				device_pixel_ratio: window.devicePixelRatio,
				video_width: video.videoWidth,
				video_height: video.videoHeight,
				track_settings: track.getSettings(),
				scale_y
			});

			let canvas_height = Math.ceil(document_height * scale_y);
			const pdf_page_height = Math.max(
				1,
				Math.min(
					Math.round((PDF_SPLIT_BY_FULLSCREEN ? window.screen.height || window.innerHeight : viewport_height) * scale_y),
					max_part_height
				)
			);

			const pdf_exporter = create_pdf_exporter(canvas_width, pdf_page_height);
			const image_assembler = create_image_assembler(video, canvas_width, max_part_height, image_format, pdf_exporter, canvas_height);

			const scroll_overlap = 2 / scale_y;
			let covered_height = 0;
			while (covered_height < document_height) {
				const requested_scroll_y = Math.max(0, covered_height - scroll_overlap);
				window.scrollTo(0, requested_scroll_y);
				await wait_for_paint();
				await wait_for_video_frames(video);

				if (covered_height > 0) {
					hide_sticky_navbars(hidden_navbars);
					await wait_for_paint();
					await wait_for_video_frames(video);
				}

				const new_document_height = get_document_height(root);
				if (new_document_height > document_height) {
					canvas_height = Math.ceil(new_document_height * scale_y);
					image_assembler.set_height(canvas_height);
					document_height = new_document_height;
					window.scrollTo(0, requested_scroll_y);
					await wait_for_paint();
					await wait_for_video_frames(video);
				}

				const actual_scroll_y = window.scrollY,
					source_offset = Math.max(0, covered_height - actual_scroll_y),
					segment_height = Math.min(viewport_height - source_offset, document_height - covered_height),
					destination_top = Math.round(covered_height * scale_y),
					destination_bottom = Math.min(canvas_height, Math.round((covered_height + segment_height) * scale_y));

				console.debug("[Screenshot page] segment", {
					requested_scroll_y,
					actual_scroll_y,
					scroll_error: actual_scroll_y - requested_scroll_y,
					covered_height,
					source_offset,
					segment_height,
					destination_top,
					destination_bottom
				});

				if (segment_height <= 0) {
					// ? Handling case with floating point precision size of the page, e.g. 10189.8330078125px
					const remaining_pixels = canvas_height - destination_top,
						// ? Handling case with growing page size, like on DuckDuckGo
						max_unreachable_tail_pixels = Math.max(4, Math.ceil(4 * scale_y));

					if (remaining_pixels <= max_unreachable_tail_pixels && source_offset >= viewport_height - 1) {
						image_assembler.trim_to_height(destination_top);
						canvas_height = destination_top;
						document_height = covered_height;
						console.warn("[Screenshot page] Ignoring unreachable trailing pixels:", remaining_pixels);
						covered_height = document_height;
						break;
					}

					console.error("[Screenshot page] Unable to scroll page for next segment:", { actual_scroll_y, covered_height, source_offset, viewport_height, document_height, segment_height, scale_y, destination_top, "canvas.height": canvas.height, destination_bottom });
					throw new Error("Unable to scroll page for next segment.");
				}

				await image_assembler.draw_video_rows(
					Math.round(source_offset * scale_y),
					destination_top,
					destination_bottom - destination_top
				);
				covered_height += segment_height;
			}

			const completed_parts = await image_assembler.finish(),
				filename_base = `${location.hostname}-${new Date().toISOString().replace(/[:.]/g, "-")}`;

			for (let index = 0; index < completed_parts.length; index++) {
				const href = URL.createObjectURL(completed_parts[index]),
					part_suffix = completed_parts.length > 1 ? `-part-${String(index + 1).padStart(2, "0")}-of-${String(completed_parts.length).padStart(2, "0")}` : "",
					link = create_element("a", {
						href,
						download: `${filename_base}${part_suffix}.${image_format.extension}`
					});

				document.body.appendChild(link);
				link.click();
				link.remove();
				setTimeout(() => URL.revokeObjectURL(href), 60_000);
				if (index < completed_parts.length - 1) await new Promise(resolve => setTimeout(resolve, 250));
			}

			if (SAVE_PDF) {
				const pdf = pdf_exporter.finish();

				if (!pdf) throw new Error("No PDF pages were generated.");

				pdf.save(`${filename_base}.pdf`);
			}
		} catch (err) {
			if (err.name !== "AbortError") {
				console.error("[Screenshot page] Screenshot failed:", err);
				alert(`[Screenshot page] Unable to create screenshot: ${err.message}`);
			}
		} finally {
			stream?.getTracks().forEach(track => track.stop());
			video?.remove();
			for (const [element, original_visibility] of hidden_navbars) {
				if (original_visibility.value) {
					element.style.setProperty("visibility", original_visibility.value, original_visibility.priority);
				} else {
					element.style.removeProperty("visibility");
				}
			}
			root.style.scrollBehavior = original_scroll_behavior;
			root.style.scrollbarColor = original_scrollbar_color;
			root.style.scrollbarWidth = original_scrollbar_width;
			root.style.pointerEvents = original_pointer_events;
			root.style.cursor = original_cursor;
			window.scrollTo(0, original_scroll_y);
		}
	};

	/** Run page capture when the configured keyboard shortcut is pressed.
	 * @param {KeyboardEvent} e Keyboard event from the document.
	 * @returns {void}
	 */
	const capture_hotkey = (e) => {
		if (!e || e.repeat || normalize_hotkey_key(e.code) !== capture_hotkey_config.key || (e.ctrlKey !== capture_hotkey_config.ctrl || e.altKey !== capture_hotkey_config.alt || e.shiftKey !== capture_hotkey_config.shift || e.metaKey !== capture_hotkey_config.meta)) return;

		e.preventDefault();
		capture();
	};

	document.addEventListener("keydown", capture_hotkey);
})();
