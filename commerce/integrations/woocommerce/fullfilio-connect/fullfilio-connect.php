<?php
/**
 * Plugin Name:       Fullfilio Connect for WooCommerce
 * Description:       Connects this WooCommerce store to Fullfilio: orders arrive instantly, unfinished checkouts are captured, risky orders are checked at checkout (with an advance payment by delivery level) and every order carries the ad it came from.
 * Version:           1.6.0
 * Requires at least: 6.2
 * Requires PHP:      7.4
 * Author:            Fullfilio
 * License:           GPL-2.0-or-later
 * Text Domain:       fullfilio-connect
 * WC requires at least: 7.8
 * WC tested up to:   9.9
 *
 * The store's data still moves through WooCommerce's own REST API and webhooks
 * (Fullfilio reads orders and products with the keys you approve). This plugin
 * adds what those cannot do: checkout-time capture and checks, attribution,
 * a retrying delivery queue for its own events, and a health report.
 */

defined( 'ABSPATH' ) || exit;

define( 'FFC_VERSION', '1.6.0' );
define( 'FFC_FILE', __FILE__ );
define( 'FFC_DIR', plugin_dir_path( __FILE__ ) );
define( 'FFC_URL', plugin_dir_url( __FILE__ ) );

require_once FFC_DIR . 'includes/class-ffc-log.php';
require_once FFC_DIR . 'includes/class-ffc-settings.php';
require_once FFC_DIR . 'includes/class-ffc-signer.php';
require_once FFC_DIR . 'includes/class-ffc-outbox.php';
require_once FFC_DIR . 'includes/class-ffc-api.php';
require_once FFC_DIR . 'includes/class-ffc-rest.php';
require_once FFC_DIR . 'includes/class-ffc-checkout.php';
require_once FFC_DIR . 'includes/class-ffc-advance.php';
require_once FFC_DIR . 'includes/class-ffc-orders.php';
require_once FFC_DIR . 'includes/class-ffc-stock.php';
require_once FFC_DIR . 'includes/class-ffc-stats.php';
require_once FFC_DIR . 'includes/class-ffc-protect.php';
require_once FFC_DIR . 'includes/class-ffc-tracking.php';
require_once FFC_DIR . 'includes/class-ffc-health.php';
require_once FFC_DIR . 'includes/class-ffc-updater.php';
require_once FFC_DIR . 'includes/class-ffc-admin.php';

// Orders are read and written through the WooCommerce CRUD only, so custom order tables (HPOS) are fine.
add_action(
	'before_woocommerce_init',
	static function () {
		if ( class_exists( \Automattic\WooCommerce\Utilities\FeaturesUtil::class ) ) {
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'custom_order_tables', FFC_FILE, true );
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'cart_checkout_blocks', FFC_FILE, true );
		}
	}
);

register_activation_hook( FFC_FILE, array( 'FFC_Outbox', 'install' ) );
register_activation_hook( FFC_FILE, array( 'FFC_Health', 'schedule' ) );
register_deactivation_hook( FFC_FILE, array( 'FFC_Health', 'unschedule' ) );

/** True when WooCommerce is active on this site (or network-wide). */
function ffc_woocommerce_active() {
	return class_exists( 'WooCommerce' ) || function_exists( 'WC' );
}

add_action(
	'plugins_loaded',
	static function () {
		// The admin page explains what is missing and updates keep working; nothing else runs without WooCommerce.
		FFC_Admin::init();
		FFC_Updater::init();
		if ( ! ffc_woocommerce_active() ) {
			return;
		}
		FFC_Outbox::maybe_upgrade();
		FFC_Rest::init();
		FFC_Checkout::init();
		FFC_Advance::init();
		FFC_Orders::init();
		FFC_Stock::init();
		FFC_Stats::init();
		FFC_Protect::init();
		FFC_Tracking::init();
		FFC_Health::init();
	},
	20
);
