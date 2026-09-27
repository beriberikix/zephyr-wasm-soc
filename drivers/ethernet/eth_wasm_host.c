/*
 * An Ethernet interface whose wire is the host.
 *
 * A frame the stack sends goes to the host whole, header included and no
 * FCS, and the host hands it to the board at the other end of the link: on
 * the page another board in another Worker, under Node another Host in the
 * same process. Frames from that board arrive the way touches and sensor
 * values do: the host queues them and raises WASM_IRQ_ETH. The ISR only
 * schedules work; the work handler drains the queue into the stack from
 * thread context, so allocation and the stack's own locking stay out of
 * interrupt context.
 *
 * The MAC comes from the board's entropy source, which the host seeds per
 * board. A MAC from sys_rand_get() would not do: the network samples set
 * CONFIG_TEST_RANDOM_GENERATOR, and two boards would draw the same address,
 * which IPv6 duplicate address detection then refuses.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#define DT_DRV_COMPAT wasm_host_ethernet

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/irq.h>
#include <zephyr/drivers/entropy.h>
#include <zephyr/net/ethernet.h>
#include <zephyr/net/net_pkt.h>
#include <zephyr/net/net_if.h>
#include <zephyr/logging/log.h>
#include <zephyr/arch/wasm/wasm_host.h>

LOG_MODULE_REGISTER(eth_wasm_host, CONFIG_ETHERNET_LOG_LEVEL);

/* The largest frame either way: a full MTU, the header and a VLAN tag. */
#define FRAME_MAX (NET_ETH_MTU + sizeof(struct net_eth_hdr) + 4)

struct eth_wasm_host_data {
	struct net_if *iface;
	struct k_work rx_work;
	uint8_t mac[6];
	uint8_t tx_buf[FRAME_MAX];
	uint8_t rx_buf[FRAME_MAX];
};

static void eth_wasm_host_rx(struct k_work *work)
{
	struct eth_wasm_host_data *data =
		CONTAINER_OF(work, struct eth_wasm_host_data, rx_work);
	int32_t len;

	while ((len = wasm_host_eth_recv(data->rx_buf, sizeof(data->rx_buf))) != 0) {
		if (len < 0 || data->iface == NULL) {
			continue;
		}

		struct net_pkt *pkt = net_pkt_rx_alloc_with_buffer(data->iface, len,
								   NET_AF_UNSPEC, 0, K_NO_WAIT);
		if (pkt == NULL) {
			/* Out of buffers: the frame is lost, as it would be on a
			 * wire. The protocols above retransmit.
			 */
			LOG_DBG("no buffer for a %d-byte frame", len);
			continue;
		}
		if (net_pkt_write(pkt, data->rx_buf, len) < 0 ||
		    net_recv_data(data->iface, pkt) < 0) {
			net_pkt_unref(pkt);
		}
	}
}

static void eth_wasm_host_isr(const struct device *dev)
{
	struct eth_wasm_host_data *data = dev->data;

	k_work_submit(&data->rx_work);
}

static int eth_wasm_host_send(const struct device *dev, struct net_pkt *pkt)
{
	struct eth_wasm_host_data *data = dev->data;
	size_t len = net_pkt_get_len(pkt);

	if (len > sizeof(data->tx_buf)) {
		return -EMSGSIZE;
	}
	if (net_pkt_read(pkt, data->tx_buf, len) < 0) {
		return -EIO;
	}
	wasm_host_eth_send(data->tx_buf, len);
	return 0;
}

static enum ethernet_hw_caps eth_wasm_host_caps(const struct device *dev,
						 struct net_if *iface)
{
	ARG_UNUSED(dev);
	ARG_UNUSED(iface);

	/* Nothing offloaded: the stack computes its own checksums. */
	return 0;
}

static void eth_wasm_host_iface_init(struct net_if *iface)
{
	const struct device *dev = net_if_get_device(iface);
	struct eth_wasm_host_data *data = dev->data;

	data->iface = iface;
	ethernet_init(iface);
	net_if_set_link_addr(iface, data->mac, sizeof(data->mac), NET_LINK_ETHERNET);
}

static int eth_wasm_host_init(const struct device *dev)
{
	struct eth_wasm_host_data *data = dev->data;
	const struct device *entropy = DEVICE_DT_GET(DT_CHOSEN(zephyr_entropy));

	if (!device_is_ready(entropy) ||
	    entropy_get_entropy(entropy, data->mac, sizeof(data->mac)) < 0) {
		return -ENODEV;
	}
	/* Unicast, and locally administered: not a vendor's address. */
	data->mac[0] = (data->mac[0] & ~0x01) | 0x02;

	k_work_init(&data->rx_work, eth_wasm_host_rx);
	return 0;
}

static const struct ethernet_api eth_wasm_host_api = {
	.iface_api.init = eth_wasm_host_iface_init,
	.get_capabilities = eth_wasm_host_caps,
	.send = eth_wasm_host_send,
};

#define ETH_WASM_HOST_DEFINE(n)                                                            \
	static struct eth_wasm_host_data eth_wasm_host_data_##n;                           \
	static int eth_wasm_host_init_##n(const struct device *dev)                        \
	{                                                                                  \
		int ret = eth_wasm_host_init(dev);                                         \
		if (ret == 0) {                                                            \
			IRQ_CONNECT(DT_INST_IRQN(n), 0, eth_wasm_host_isr,                 \
				    DEVICE_DT_INST_GET(n), 0);                             \
			irq_enable(DT_INST_IRQN(n));                                       \
		}                                                                          \
		return ret;                                                                \
	}                                                                                  \
	ETH_NET_DEVICE_DT_INST_DEFINE(n, eth_wasm_host_init_##n, NULL,                     \
				      &eth_wasm_host_data_##n, NULL,                       \
				      CONFIG_ETH_INIT_PRIORITY, &eth_wasm_host_api,        \
				      NET_ETH_MTU);

DT_INST_FOREACH_STATUS_OKAY(ETH_WASM_HOST_DEFINE)
