/*
 * A display the host draws.
 *
 * The framebuffer is a static array, so it lives in linear memory, which the
 * host can read whenever the guest is not running. The guest names it to the
 * host once, at init, and reports each rectangle it writes; the host keeps the
 * dirty region and draws it -- onto a <canvas> in the browser -- when it gets
 * round to it. Nothing here waits on the host, the same arrangement as the
 * flash (DESIGN.md D8h).
 *
 * One pixel format, RGB565, stored as native little-endian 16-bit words. It
 * is LVGL's default colour depth, so its samples run as upstream wrote them.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#define DT_DRV_COMPAT wasm_host_display

#include <errno.h>
#include <string.h>

#include <zephyr/device.h>
#include <zephyr/drivers/display.h>
#include <zephyr/arch/wasm/wasm_host.h>

#define BYTES_PER_PIXEL 2

struct wasm_display_config {
	uint16_t width;
	uint16_t height;
	uint8_t *fb;
};

static bool in_bounds(const struct wasm_display_config *cfg, uint16_t x, uint16_t y,
		      const struct display_buffer_descriptor *desc)
{
	return desc->width <= desc->pitch && x + desc->width <= cfg->width &&
	       y + desc->height <= cfg->height;
}

static int wasm_display_write(const struct device *dev, const uint16_t x, const uint16_t y,
			      const struct display_buffer_descriptor *desc, const void *buf)
{
	const struct wasm_display_config *cfg = dev->config;
	const uint8_t *src = buf;

	if (!in_bounds(cfg, x, y, desc)) {
		return -EINVAL;
	}
	for (uint16_t row = 0; row < desc->height; row++) {
		memcpy(cfg->fb + ((size_t)(y + row) * cfg->width + x) * BYTES_PER_PIXEL,
		       src + (size_t)row * desc->pitch * BYTES_PER_PIXEL,
		       (size_t)desc->width * BYTES_PER_PIXEL);
	}
	wasm_host_display_flush(x, y, desc->width, desc->height);
	return 0;
}

static int wasm_display_read(const struct device *dev, const uint16_t x, const uint16_t y,
			     const struct display_buffer_descriptor *desc, void *buf)
{
	const struct wasm_display_config *cfg = dev->config;
	uint8_t *dst = buf;

	if (!in_bounds(cfg, x, y, desc)) {
		return -EINVAL;
	}
	for (uint16_t row = 0; row < desc->height; row++) {
		memcpy(dst + (size_t)row * desc->pitch * BYTES_PER_PIXEL,
		       cfg->fb + ((size_t)(y + row) * cfg->width + x) * BYTES_PER_PIXEL,
		       (size_t)desc->width * BYTES_PER_PIXEL);
	}
	return 0;
}

static int wasm_display_blanking_on(const struct device *dev)
{
	ARG_UNUSED(dev);
	wasm_host_display_blank(1);
	return 0;
}

static int wasm_display_blanking_off(const struct device *dev)
{
	ARG_UNUSED(dev);
	wasm_host_display_blank(0);
	return 0;
}

static void wasm_display_get_capabilities(const struct device *dev,
					  struct display_capabilities *caps)
{
	const struct wasm_display_config *cfg = dev->config;

	memset(caps, 0, sizeof(*caps));
	caps->x_resolution = cfg->width;
	caps->y_resolution = cfg->height;
	caps->supported_pixel_formats = PIXEL_FORMAT_RGB_565;
	caps->current_pixel_format = PIXEL_FORMAT_RGB_565;
	caps->current_orientation = DISPLAY_ORIENTATION_NORMAL;
}

static int wasm_display_set_pixel_format(const struct device *dev,
					 const enum display_pixel_format pf)
{
	ARG_UNUSED(dev);
	return pf == PIXEL_FORMAT_RGB_565 ? 0 : -ENOTSUP;
}

static int wasm_display_init(const struct device *dev)
{
	const struct wasm_display_config *cfg = dev->config;

	wasm_host_display_attach(cfg->fb, cfg->width, cfg->height, PIXEL_FORMAT_RGB_565);
	return 0;
}

static DEVICE_API(display, wasm_display_api) = {
	.blanking_on = wasm_display_blanking_on,
	.blanking_off = wasm_display_blanking_off,
	.write = wasm_display_write,
	.read = wasm_display_read,
	.get_capabilities = wasm_display_get_capabilities,
	.set_pixel_format = wasm_display_set_pixel_format,
};

#define WASM_DISPLAY_DEFINE(n)                                                                     \
	BUILD_ASSERT(DT_INST_PROP(n, pixel_format) == PIXEL_FORMAT_RGB_565,                         \
		     "this display is RGB565 only");                                               \
	static uint8_t wasm_display_fb_##n[DT_INST_PROP(n, width) * DT_INST_PROP(n, height) *      \
					   BYTES_PER_PIXEL] __aligned(4);                          \
	static const struct wasm_display_config wasm_display_config_##n = {                        \
		.width = DT_INST_PROP(n, width),                                                   \
		.height = DT_INST_PROP(n, height),                                                 \
		.fb = wasm_display_fb_##n,                                                         \
	};                                                                                         \
	DEVICE_DT_INST_DEFINE(n, wasm_display_init, NULL, NULL, &wasm_display_config_##n,          \
			      POST_KERNEL, CONFIG_DISPLAY_INIT_PRIORITY, &wasm_display_api);

DT_INST_FOREACH_STATUS_OKAY(WASM_DISPLAY_DEFINE)
