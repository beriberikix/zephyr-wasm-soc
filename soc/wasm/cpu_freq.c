/*
 * The SoC's P-state setter for the CPU frequency subsystem.
 * SPDX-License-Identifier: Apache-2.0
 *
 * The board declares three performance states (wasm_node.dts), and the
 * policies choose among them by load. There is no clock here to slow down:
 * the guest runs as fast as the host lets it. So setting a state records it
 * and says so, as native_sim's does, and the policy above it runs exactly as
 * it would on a part that scales.
 */

#include <zephyr/kernel.h>
#include <zephyr/devicetree.h>
#include <zephyr/cpu_freq/cpu_freq.h>
#include <zephyr/cpu_freq/pstate.h>
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(wasm_cpu_freq, CONFIG_CPU_FREQ_LOG_LEVEL);

struct wasm_pstate_config {
	int state_id;
};

static int current_state = -1;

int cpu_freq_pstate_set(const struct pstate *state)
{
	if (state == NULL) {
		LOG_ERR("SoC pstate is NULL");
		return -EINVAL;
	}

	int id = ((const struct wasm_pstate_config *)state->config)->state_id;

	if (id != current_state) {
		LOG_DBG("SoC setting P-state %d", id);
		current_state = id;
	}
	return 0;
}

#define WASM_PSTATE_DEFINE(node_id)                                                                \
	static const struct wasm_pstate_config _CONCAT(wasm_pstate_config_, node_id) = {           \
		.state_id = DT_PROP(node_id, pstate_id),                                           \
	};                                                                                         \
	PSTATE_DT_DEFINE(node_id, &_CONCAT(wasm_pstate_config_, node_id))

DT_FOREACH_CHILD_STATUS_OKAY(DT_PATH(performance_states), WASM_PSTATE_DEFINE)
