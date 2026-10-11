<?php
/**
 * Plugin Name: WooCommerce stand-in (tests only)
 * Description: The parts of WooCommerce that Fullfilio and the Fullfilio Connect plugin use, for an
 *              offline test store: cart + session, the classic checkout (with its validation hook),
 *              orders with status hooks, the wc/v3 REST API with API-key authentication, the
 *              /wc-auth/v1/authorize approval screen and signed webhooks that WooCommerce pauses
 *              after 5 failed deliveries. It is NOT WooCommerce; it exists because the test
 *              environment cannot download WooCommerce. Never install it on a real site.
 *
 * Behaviour follows WooCommerce's documented API: X-WC-Webhook-* headers with
 * base64(HMAC-SHA256(body, secret)), the webhook creation ping "webhook_id=<id>", consumer keys
 * ck_/cs_ + 40 hex, the wc-auth callback body {key_id, user_id, consumer_key, consumer_secret,
 * key_permissions}, and woocommerce_rest_is_request_to_rest_api deciding which REST requests
 * the keys authenticate.
 */

defined( 'ABSPATH' ) || exit;

define( 'WC_VERSION', '9.9.0-standin' );

class WooCommerce {}

// WooCommerce gives administrators (and shop managers) manage_woocommerce and adds its own admin menu.
add_filter(
	'user_has_cap',
	function ( $all ) {
		if ( ! empty( $all['manage_options'] ) ) {
			$all['manage_woocommerce'] = true;
		}
		return $all;
	}
);
add_action(
	'admin_menu',
	function () {
		add_menu_page( 'WooCommerce', 'WooCommerce', 'manage_woocommerce', 'woocommerce', '__return_null', 'dashicons-cart', 55 );
	}
);

// ---------------------------------------------------------------- storage ----------------------
function standin_table( $name ) {
	global $wpdb;
	return $wpdb->prefix . 'standin_' . $name;
}

function standin_install() {
	global $wpdb;
	if ( get_option( 'standin_db' ) === '3' ) {
		return;
	}
	require_once ABSPATH . 'wp-admin/includes/upgrade.php';
	$c = $wpdb->get_charset_collate();
	foreach ( array( 'orders', 'products', 'webhooks', 'notes', 'keys', 'deliveries' ) as $t ) {
		dbDelta( 'CREATE TABLE ' . standin_table( $t ) . " (id bigint(20) unsigned NOT NULL AUTO_INCREMENT, data longtext NOT NULL, PRIMARY KEY  (id)) $c;" );
	}
	if ( ! $wpdb->get_var( 'SELECT COUNT(*) FROM ' . standin_table( 'products' ) ) ) {
		standin_put( 'products', null, array( 'name' => 'Linen Shirt', 'type' => 'variable', 'sku' => 'LS', 'price' => '650', 'status' => 'publish', 'manage_stock' => false, 'stock_quantity' => null,
			'variations' => array(
				array( 'id' => 101, 'sku' => 'LS-M', 'price' => '650', 'manage_stock' => true, 'stock_quantity' => 20, 'attributes' => array( array( 'name' => 'Size', 'option' => 'M' ) ) ),
				array( 'id' => 102, 'sku' => 'LS-L', 'price' => '650', 'manage_stock' => true, 'stock_quantity' => 15, 'attributes' => array( array( 'name' => 'Size', 'option' => 'L' ) ) ),
			) ) );
		standin_put( 'products', null, array( 'name' => 'Canvas Tote Bag', 'type' => 'simple', 'sku' => 'TOTE', 'price' => '450', 'status' => 'publish', 'manage_stock' => true, 'stock_quantity' => 40, 'variations' => array() ) );
	}
	if ( ! get_option( 'woocommerce_checkout_page_id' ) ) {
		$id = wp_insert_post( array( 'post_title' => 'Checkout', 'post_name' => 'checkout', 'post_status' => 'publish', 'post_type' => 'page', 'post_content' => '[woocommerce_checkout]' ) );
		update_option( 'woocommerce_checkout_page_id', $id );
	}
	update_option( 'standin_db', '3' );
}
add_action( 'init', 'standin_install', 1 );

function standin_get( $t, $id ) {
	global $wpdb;
	$row = $wpdb->get_var( $wpdb->prepare( 'SELECT data FROM ' . standin_table( $t ) . ' WHERE id = %d', $id ) ); // phpcs:ignore
	return $row ? array_merge( json_decode( $row, true ), array( 'id' => (int) $id ) ) : null;
}

function standin_put( $t, $id, $data ) {
	global $wpdb;
	unset( $data['id'] );
	if ( $id ) {
		$wpdb->update( standin_table( $t ), array( 'data' => wp_json_encode( $data ) ), array( 'id' => $id ) );
		return (int) $id;
	}
	$wpdb->insert( standin_table( $t ), array( 'data' => wp_json_encode( $data ) ) );
	return (int) $wpdb->insert_id;
}

function standin_all( $t ) {
	global $wpdb;
	$out = array();
	foreach ( (array) $wpdb->get_results( 'SELECT id, data FROM ' . standin_table( $t ) . ' ORDER BY id DESC', ARRAY_A ) as $r ) { // phpcs:ignore
		$out[] = array_merge( json_decode( $r['data'], true ), array( 'id' => (int) $r['id'] ) );
	}
	return $out;
}

function standin_remove( $t, $id ) {
	global $wpdb;
	$wpdb->query( $wpdb->prepare( 'DELETE FROM ' . standin_table( $t ) . ' WHERE id = %d', $id ) ); // phpcs:ignore
}

// ---------------------------------------------------------------- session + cart --------------
class Standin_Session {
	private $key;
	private $data;
	public function __construct() {
		$this->key = isset( $_COOKIE['standin_session'] ) && preg_match( '/^[a-f0-9]{32}$/', $_COOKIE['standin_session'] ) ? $_COOKIE['standin_session'] : md5( wp_generate_password( 32, false ) );
		if ( ! headers_sent() ) {
			setcookie( 'standin_session', $this->key, time() + DAY_IN_SECONDS, '/' );
		}
		$this->data = get_transient( 'standin_s_' . $this->key );
		$this->data = is_array( $this->data ) ? $this->data : array();
	}
	public function get( $k, $default = null ) {
		return array_key_exists( $k, $this->data ) ? $this->data[ $k ] : $default;
	}
	public function set( $k, $v ) {
		$this->data[ $k ] = $v;
		set_transient( 'standin_s_' . $this->key, $this->data, DAY_IN_SECONDS );
	}
	public function __unset( $k ) {
		unset( $this->data[ $k ] );
		set_transient( 'standin_s_' . $this->key, $this->data, DAY_IN_SECONDS );
	}
}

class Standin_Product {
	private $p;
	public function __construct( $p ) {
		$this->p = $p;
	}
	public function get_name() {
		return $this->p['name'];
	}
	public function get_sku() {
		return $this->p['sku'];
	}
	public function get_price() {
		return $this->p['price'];
	}
}

class Standin_Cart {
	private $session;
	public function __construct( $session ) {
		$this->session = $session;
	}
	public function add( $product_id, $variation_id, $qty ) {
		$items = $this->session->get( 'cart', array() );
		$key   = $product_id . ':' . $variation_id;
		$items[ $key ] = array( 'product_id' => (int) $product_id, 'variation_id' => (int) $variation_id, 'quantity' => ( isset( $items[ $key ] ) ? $items[ $key ]['quantity'] : 0 ) + (int) $qty );
		$this->session->set( 'cart', $items );
	}
	public function empty_cart() {
		$this->session->set( 'cart', array() );
	}
	public function is_empty() {
		return ! $this->session->get( 'cart', array() );
	}
	public function get_cart() {
		$out = array();
		foreach ( $this->session->get( 'cart', array() ) as $key => $line ) {
			$p = standin_get( 'products', $line['product_id'] );
			if ( ! $p ) {
				continue;
			}
			$name = $p['name'];
			$sku  = $p['sku'];
			if ( $line['variation_id'] ) {
				foreach ( $p['variations'] as $v ) {
					if ( (int) $v['id'] === (int) $line['variation_id'] ) {
						$name .= ' - ' . $v['attributes'][0]['option'];
						$sku   = $v['sku'];
					}
				}
			}
			$out[ $key ] = array_merge( $line, array( 'data' => new Standin_Product( array( 'name' => $name, 'sku' => $sku, 'price' => $p['price'] ) ), 'line_total' => (float) $p['price'] * $line['quantity'] ) );
		}
		return $out;
	}
	public function calculate_totals() {}
	public function get_subtotal() {
		return array_sum( wp_list_pluck( $this->get_cart(), 'line_total' ) );
	}
	public function get_shipping_total() {
		return $this->is_empty() ? 0 : 60;
	}
	public function get_total( $context = 'view' ) {
		return $this->get_subtotal() + $this->get_shipping_total();
	}
}

class Standin_WC {
	public $session;
	public $cart;
	public function __construct() {
		$this->session = new Standin_Session();
		$this->cart    = new Standin_Cart( $this->session );
	}
}

function WC() { // phpcs:ignore WordPress.NamingConventions.ValidFunctionName
	static $wc = null;
	if ( null === $wc && did_action( 'init' ) ) {
		$wc = new Standin_WC();
	}
	return $wc ? $wc : new class() {
		public $session = null;
		public $cart = null;
	};
}

class WC_AJAX {
	public static function get_endpoint( $request = '' ) {
		return esc_url_raw( add_query_arg( 'wc-ajax', $request, home_url( '/' ) ) );
	}
}

class WC_Geolocation {
	public static function get_ip_address() {
		return isset( $_SERVER['REMOTE_ADDR'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REMOTE_ADDR'] ) ) : '';
	}
}

function wc_format_decimal( $n, $dp = 2 ) {
	return number_format( (float) $n, $dp, '.', '' );
}
function get_woocommerce_currency() {
	return 'BDT';
}
function wc_get_page_id( $page ) {
	return 'checkout' === $page ? (int) get_option( 'woocommerce_checkout_page_id' ) : -1;
}
function wc_get_checkout_url() {
	return get_permalink( wc_get_page_id( 'checkout' ) );
}
function is_checkout() {
	return is_page( wc_get_page_id( 'checkout' ) );
}
function is_order_received_page() {
	return isset( $_GET['order-received'] ); // phpcs:ignore
}
function wc_get_order_statuses() {
	return apply_filters( 'wc_order_statuses', array( 'wc-pending' => 'Pending payment', 'wc-processing' => 'Processing', 'wc-on-hold' => 'On hold', 'wc-completed' => 'Completed', 'wc-cancelled' => 'Cancelled', 'wc-refunded' => 'Refunded', 'wc-failed' => 'Failed' ) );
}

function wc_get_order_status_name( $status ) {
	$all = wc_get_order_statuses();
	$key = 'wc-' . preg_replace( '/^wc-/', '', $status );
	return isset( $all[ $key ] ) ? $all[ $key ] : $status;
}

// ---------------------------------------------------------------- products + stock --------------
/** A product or one variation, with the stock calls WooCommerce has. */
class WC_Product_Standin {
	public $product_id;
	public $variation_id;
	public function __construct( $product_id, $variation_id = 0 ) {
		$this->product_id   = (int) $product_id;
		$this->variation_id = (int) $variation_id;
	}
	private function row() {
		$p = standin_get( 'products', $this->product_id );
		if ( $p && $this->variation_id ) {
			foreach ( $p['variations'] as $v ) {
				if ( (int) $v['id'] === $this->variation_id ) {
					return array_merge( $v, array( 'name' => $p['name'] . ' - ' . $v['attributes'][0]['option'], 'type' => 'variation' ) );
				}
			}
			return null;
		}
		return $p;
	}
	public function exists() {
		return null !== $this->row();
	}
	public function get_id() {
		return $this->variation_id ? $this->variation_id : $this->product_id;
	}
	public function get_parent_id() {
		return $this->variation_id ? $this->product_id : 0;
	}
	public function get_name() {
		$r = $this->row();
		return $r ? $r['name'] : '';
	}
	public function get_sku() {
		$r = $this->row();
		return $r ? (string) $r['sku'] : '';
	}
	public function is_type( $type ) {
		$r = $this->row();
		return $r && $r['type'] === $type;
	}
	public function get_children() {
		$r = $this->row();
		return $r && 'variable' === $r['type'] ? wp_list_pluck( $r['variations'], 'id' ) : array();
	}
	public function managing_stock() {
		$r = $this->row();
		return $r && ! empty( $r['manage_stock'] );
	}
	public function get_stock_quantity() {
		$r = $this->row();
		return $r && null !== $r['stock_quantity'] ? (int) $r['stock_quantity'] : null;
	}
	/** Adds $by (negative takes off) and saves; fires product.updated like WooCommerce. */
	public function change_stock( $by ) {
		$p = standin_get( 'products', $this->product_id );
		if ( $this->variation_id ) {
			foreach ( $p['variations'] as $i => $v ) {
				if ( (int) $v['id'] === $this->variation_id ) {
					$p['variations'][ $i ]['stock_quantity'] = (int) $v['stock_quantity'] + $by;
					standin_put( 'products', $p['id'], $p );
					standin_fire_webhooks( 'product.updated', array_merge( standin_product_rest( $p, $p['variations'][ $i ] ), array( 'parent_id' => $p['id'] ) ) );
					return $p['variations'][ $i ]['stock_quantity'];
				}
			}
			return null;
		}
		$p['stock_quantity'] = (int) $p['stock_quantity'] + $by;
		standin_put( 'products', $p['id'], $p );
		standin_fire_webhooks( 'product.updated', standin_product_rest( $p ) );
		return $p['stock_quantity'];
	}
}

function wc_get_product( $id ) {
	$id = (int) $id;
	if ( standin_get( 'products', $id ) ) {
		return new WC_Product_Standin( $id );
	}
	foreach ( standin_all( 'products' ) as $p ) {
		foreach ( $p['variations'] as $v ) {
			if ( (int) $v['id'] === $id ) {
				return new WC_Product_Standin( $p['id'], $id );
			}
		}
	}
	return false;
}

function wc_get_products( $args = array() ) {
	return array_map( static function ( $p ) { return new WC_Product_Standin( $p['id'] ); }, array_reverse( standin_all( 'products' ) ) );
}

/** Like wc_update_product_stock( $product, $n, 'increase' | 'decrease' ): returns the new count. */
function wc_update_product_stock( $product, $n, $operation = 'set' ) {
	if ( ! $product || ! $product->managing_stock() ) {
		return null;
	}
	$now = (int) $product->get_stock_quantity();
	$by  = 'increase' === $operation ? (int) $n : ( 'decrease' === $operation ? -(int) $n : (int) $n - $now );
	return $product->change_stock( $by );
}

/** An order line, stored inside the order (line_items[i]); item meta like WooCommerce's. */
class WC_Order_Item_Product {
	private $order_id;
	private $index;
	private $line;
	public function __construct( $order_id, $index, $line ) {
		$this->order_id = (int) $order_id;
		$this->index    = (int) $index;
		$this->line     = $line;
	}
	public function get_id() {
		return (int) $this->line['id'];
	}
	public function get_product_id() {
		return (int) $this->line['product_id'];
	}
	public function get_variation_id() {
		return (int) $this->line['variation_id'];
	}
	public function get_name() {
		return $this->line['name'];
	}
	public function get_quantity() {
		return (int) $this->line['quantity'];
	}
	public function get_product() {
		$p = new WC_Product_Standin( $this->line['product_id'], $this->line['variation_id'] );
		return $p->exists() ? $p : false;
	}
	public function get_meta( $key, $single = true ) {
		foreach ( $this->line['meta_data'] as $m ) {
			if ( $m['key'] === $key ) {
				return $m['value'];
			}
		}
		return '';
	}
	public function update_meta_data( $key, $value ) {
		foreach ( $this->line['meta_data'] as $i => $m ) {
			if ( $m['key'] === $key ) {
				$this->line['meta_data'][ $i ]['value'] = $value;
				return;
			}
		}
		$this->line['meta_data'][] = array( 'id' => count( $this->line['meta_data'] ) + 1, 'key' => $key, 'value' => $value );
	}
	public function delete_meta_data( $key ) {
		$this->line['meta_data'] = array_values( array_filter( $this->line['meta_data'], static function ( $m ) use ( $key ) { return $m['key'] !== $key; } ) );
	}
	public function save() {
		$o = standin_get( 'orders', $this->order_id );
		$o['line_items'][ $this->index ] = $this->line;
		standin_put( 'orders', $this->order_id, $o );
	}
}

/** Like wc_maybe_reduce_stock_levels: once per order, on processing / on-hold / completed. */
function standin_reduce_stock( $order_id ) {
	$order = wc_get_order( $order_id );
	if ( ! $order || $order->get_meta( '_order_stock_reduced' ) ) {
		return;
	}
	$changes = array();
	foreach ( $order->get_items() as $item ) {
		$product = $item->get_product();
		if ( ! $product || ! $product->managing_stock() || $item->get_meta( '_reduced_stock' ) ) {
			continue;
		}
		$from = $product->get_stock_quantity();
		$to   = wc_update_product_stock( $product, $item->get_quantity(), 'decrease' );
		$item->update_meta_data( '_reduced_stock', $item->get_quantity() );
		$item->save();
		$changes[] = $item->get_name() . ' ' . $from . '→' . $to;
	}
	$order = wc_get_order( $order_id );
	$order->update_meta_data( '_order_stock_reduced', 'yes' );
	$order->save();
	if ( $changes ) {
		$order->add_order_note( 'Stock levels reduced: ' . implode( ', ', $changes ) );
	}
}

/** Like wc_maybe_increase_stock_levels: on cancelled, only what was taken off, unless a plugin says no. */
function standin_restore_stock( $order_id ) {
	$order = wc_get_order( $order_id );
	if ( ! $order || ! $order->get_meta( '_order_stock_reduced' ) ) {
		return;
	}
	if ( ! apply_filters( 'woocommerce_can_restore_order_stock', true, $order ) ) {
		return;
	}
	$changes = array();
	foreach ( wc_get_order( $order_id )->get_items() as $item ) {
		$product = $item->get_product();
		$reduced = (int) $item->get_meta( '_reduced_stock' );
		if ( ! $product || ! $product->managing_stock() || $reduced <= 0 ) {
			continue;
		}
		$from = $product->get_stock_quantity();
		$to   = wc_update_product_stock( $product, $reduced, 'increase' );
		$item->delete_meta_data( '_reduced_stock' );
		$item->save();
		$changes[] = $item->get_name() . ' ' . $from . '→' . $to;
	}
	$order = wc_get_order( $order_id );
	$order->update_meta_data( '_order_stock_reduced', '' );
	$order->save();
	if ( $changes ) {
		$order->add_order_note( 'Stock levels increased: ' . implode( ', ', $changes ) );
	}
}
foreach ( array( 'processing', 'on-hold', 'completed' ) as $standin_st ) {
	add_action( 'woocommerce_order_status_' . $standin_st, 'standin_reduce_stock' );
}
add_action( 'woocommerce_order_status_cancelled', 'standin_restore_stock' );

// ---------------------------------------------------------------- orders ------------------------
class WC_Order {
	public $data;
	public function __construct( $data ) {
		$this->data = $data;
	}
	public function get_id() {
		return (int) $this->data['id'];
	}
	public function get_type() {
		return 'shop_order';
	}
	public function get_status() {
		return $this->data['status'];
	}
	public function get_order_number() {
		return (string) $this->data['id'];
	}
	public function get_total() {
		return $this->data['total'];
	}
	public function get_payment_method() {
		return $this->data['payment_method'];
	}
	public function get_billing_phone() {
		return $this->data['billing']['phone'];
	}
	public function get_shipping_phone() {
		return '';
	}
	public function get_billing_address_1() {
		return $this->data['billing']['address_1'];
	}
	public function get_billing_city() {
		return $this->data['billing']['city'];
	}
	public function get_meta( $key ) {
		foreach ( $this->data['meta_data'] as $m ) {
			if ( $m['key'] === $key ) {
				return $m['value'];
			}
		}
		return '';
	}
	public function update_meta_data( $key, $value ) {
		foreach ( $this->data['meta_data'] as $i => $m ) {
			if ( $m['key'] === $key ) {
				$this->data['meta_data'][ $i ]['value'] = $value;
				return;
			}
		}
		$this->data['meta_data'][] = array( 'id' => count( $this->data['meta_data'] ) + 1, 'key' => $key, 'value' => $value );
	}
	public function save_meta_data() {
		$this->save();
	}
	public function save() {
		standin_put( 'orders', $this->get_id(), $this->data );
	}
	public function get_edit_order_url() {
		return admin_url( 'post.php?post=' . $this->get_id() . '&action=edit' );
	}
	public function get_items() {
		$out = array();
		foreach ( $this->data['line_items'] as $i => $line ) {
			$out[ (int) $line['id'] ] = new WC_Order_Item_Product( $this->get_id(), $i, $line );
		}
		return $out;
	}
	public function add_order_note( $note, $is_customer_note = 0 ) {
		return standin_put( 'notes', null, array( 'order_id' => $this->get_id(), 'note' => (string) $note, 'customer_note' => (bool) $is_customer_note ) );
	}
	/** Like WC_Order::update_status( $to, $note ): note first, then the status with its hooks. */
	public function update_status( $to, $note = '' ) {
		$fresh      = wc_get_order( $this->get_id() );
		$this->data = $fresh->data;
		$from       = $this->data['status'];
		$to         = preg_replace( '/^wc-/', '', $to );
		$this->add_order_note( trim( $note . ' ' . sprintf( 'Order status changed from %s to %s.', wc_get_order_status_name( $from ), wc_get_order_status_name( $to ) ) ) );
		$this->set_status_and_save( $to );
		return true;
	}
	/** Like WC_Order::set_status + save: fires the status hooks and the order.updated webhook. */
	public function set_status_and_save( $to ) {
		$from = $this->data['status'];
		$to   = preg_replace( '/^wc-/', '', $to );
		$this->data['status']               = $to;
		$this->data['date_modified_gmt']    = gmdate( 'Y-m-d\TH:i:s' );
		$this->save();
		if ( $from !== $to ) {
			do_action( 'woocommerce_order_status_' . $to, $this->get_id(), $this );
			do_action( 'woocommerce_order_status_changed', $this->get_id(), $from, $to, $this );
		}
		standin_fire_webhooks( 'order.updated', standin_order_rest( $this ) );
	}
}

function wc_get_order( $id ) {
	$o = standin_get( 'orders', $id );
	return $o ? new WC_Order( $o ) : false;
}

function standin_order_rest( WC_Order $o ) {
	$d = $o->data;
	// Like the REST API: hidden line item meta (keys starting with "_") is left out.
	foreach ( $d['line_items'] as $i => $line ) {
		$d['line_items'][ $i ]['meta_data'] = array_values( array_filter( $line['meta_data'], static function ( $m ) { return '_' !== substr( $m['key'], 0, 1 ); } ) );
	}
	return array_merge( $d, array( 'id' => $o->get_id(), 'number' => (string) $o->get_id() ) );
}

function standin_create_order( $data, $cart ) {
	$lines = array();
	foreach ( $cart->get_cart() as $line ) {
		$lines[] = array( 'id' => 0, 'product_id' => $line['product_id'], 'variation_id' => $line['variation_id'], 'name' => $line['data']->get_name(), 'quantity' => $line['quantity'],
			'subtotal' => wc_format_decimal( $line['line_total'] ), 'total' => wc_format_decimal( $line['line_total'] ), 'sku' => $line['data']->get_sku(), 'meta_data' => array(), 'image' => null );
	}
	$order = array(
		'status' => 'cod' === $data['payment_method'] ? 'processing' : 'on-hold', 'currency' => 'BDT',
		'date_created_gmt' => gmdate( 'Y-m-d\TH:i:s' ), 'date_modified_gmt' => gmdate( 'Y-m-d\TH:i:s' ), 'date_paid_gmt' => null,
		'total' => wc_format_decimal( $cart->get_total() ), 'shipping_total' => wc_format_decimal( $cart->get_shipping_total() ), 'discount_total' => '0.00',
		'payment_method' => $data['payment_method'], 'payment_method_title' => 'cod' === $data['payment_method'] ? 'Cash on delivery' : 'bKash',
		'customer_note' => $data['order_comments'],
		'billing' => array( 'first_name' => $data['billing_first_name'], 'last_name' => $data['billing_last_name'], 'address_1' => $data['billing_address_1'], 'address_2' => '',
			'city' => $data['billing_city'], 'state' => $data['billing_state'], 'postcode' => '', 'country' => 'BD', 'phone' => $data['billing_phone'], 'email' => $data['billing_email'] ),
		'shipping' => array( 'first_name' => $data['billing_first_name'], 'last_name' => $data['billing_last_name'], 'address_1' => $data['billing_address_1'], 'address_2' => '',
			'city' => $data['billing_city'], 'state' => $data['billing_state'], 'postcode' => '', 'country' => 'BD', 'phone' => '' ),
		'line_items' => $lines, 'meta_data' => array(),
	);
	$id    = standin_put( 'orders', null, $order );
	// Line ids are unique store-wide in WooCommerce.
	foreach ( $order['line_items'] as $i => $line ) {
		$order['line_items'][ $i ]['id'] = $id * 100 + $i + 1;
	}
	standin_put( 'orders', $id, $order );
	// The payment step puts a COD order in processing (bKash: on-hold), which takes the stock off.
	standin_reduce_stock( $id );
	$order = wc_get_order( $id );
	do_action( 'woocommerce_checkout_order_created', $order );
	do_action( 'woocommerce_new_order', $id, $order );
	$order = wc_get_order( $id ); // re-read: hooks may have saved meta
	standin_fire_webhooks( 'order.created', standin_order_rest( $order ) );
	return $order;
}

// ---------------------------------------------------------------- front end ---------------------
add_action(
	'template_redirect',
	static function () {
		// phpcs:disable WordPress.Security.NonceVerification
		if ( isset( $_GET['add-to-cart'] ) ) {
			WC()->cart->add( (int) $_GET['add-to-cart'], isset( $_GET['variation_id'] ) ? (int) $_GET['variation_id'] : 0, isset( $_GET['quantity'] ) ? (int) $_GET['quantity'] : 1 );
			wp_safe_redirect( wc_get_checkout_url() );
			exit;
		}
		if ( isset( $_GET['wc-ajax'] ) ) {
			$action = sanitize_key( wp_unslash( $_GET['wc-ajax'] ) );
			if ( 'checkout' === $action ) {
				standin_checkout();
			}
			do_action( 'wc_ajax_' . $action );
			wp_die();
		}
		// phpcs:enable
	},
	0
);

function standin_checkout() {
	// phpcs:disable WordPress.Security.NonceVerification.Missing
	$keys = array( 'billing_first_name', 'billing_last_name', 'billing_phone', 'billing_email', 'billing_address_1', 'billing_city', 'billing_state', 'payment_method', 'order_comments' );
	$data = array();
	foreach ( $keys as $k ) {
		$data[ $k ] = isset( $_POST[ $k ] ) ? sanitize_text_field( wp_unslash( $_POST[ $k ] ) ) : '';
	}
	// phpcs:enable
	$errors = new WP_Error();
	foreach ( array( 'billing_first_name' => 'First name', 'billing_phone' => 'Phone', 'billing_address_1' => 'Address' ) as $k => $label ) {
		if ( '' === $data[ $k ] ) {
			$errors->add( 'required', $label . ' is a required field.' );
		}
	}
	if ( WC()->cart->is_empty() ) {
		$errors->add( 'cart', 'Your cart is empty.' );
	}
	do_action( 'woocommerce_after_checkout_validation', $data, $errors );
	if ( $errors->has_errors() ) {
		wp_send_json( array( 'result' => 'failure', 'messages' => implode( ' ', $errors->get_error_messages() ) ) );
	}
	$order = standin_create_order( $data, WC()->cart );
	WC()->cart->empty_cart();
	wp_send_json( array( 'result' => 'success', 'order_id' => $order->get_id(), 'redirect' => add_query_arg( 'order-received', $order->get_id(), wc_get_checkout_url() ) ) );
}

add_shortcode(
	'woocommerce_checkout',
	static function () {
		if ( is_order_received_page() ) {
			return '<p class="woocommerce-thankyou-order-received">Thank you. Your order has been received. Order #' . (int) $_GET['order-received'] . '</p>'; // phpcs:ignore
		}
		if ( WC()->cart->is_empty() ) {
			return '<p class="cart-empty">Your cart is currently empty.</p>';
		}
		ob_start();
		echo '<form class="checkout woocommerce-checkout" id="standin-checkout"><h3>Billing details</h3>';
		foreach ( array( 'billing_first_name' => 'First name', 'billing_last_name' => 'Last name', 'billing_phone' => 'Phone', 'billing_email' => 'Email', 'billing_address_1' => 'Street address', 'billing_city' => 'Town / City' ) as $id => $label ) {
			echo '<p><label for="' . esc_attr( $id ) . '">' . esc_html( $label ) . '</label><input type="text" id="' . esc_attr( $id ) . '" name="' . esc_attr( $id ) . '"></p>';
		}
		echo '<p><label for="billing_state">District</label><select id="billing_state" name="billing_state"><option value="BD-13">Dhaka</option><option value="BD-10">Chattogram</option></select></p>';
		echo '<p><label for="order_comments">Order notes</label><textarea id="order_comments" name="order_comments"></textarea></p>';
		echo '<ul class="cart">';
		foreach ( WC()->cart->get_cart() as $line ) {
			echo '<li>' . esc_html( $line['data']->get_name() . ' × ' . $line['quantity'] . ' = ' . $line['line_total'] ) . '</li>';
		}
		echo '</ul><p>Total: <strong id="order-total">' . esc_html( WC()->cart->get_total() ) . '</strong></p>';
		echo '<p><label><input type="radio" name="payment_method" value="cod" checked> Cash on delivery</label> <label><input type="radio" name="payment_method" value="bkash"> bKash</label></p>';
		echo '<div class="woocommerce-error" id="checkout-error" role="alert"></div><button type="submit" id="place_order">Place order</button></form>';
		echo '<script>document.getElementById("standin-checkout").addEventListener("submit",function(e){e.preventDefault();fetch(' . wp_json_encode( WC_AJAX::get_endpoint( 'checkout' ) ) . ',{method:"POST",credentials:"same-origin",body:new FormData(e.target)}).then(function(r){return r.json()}).then(function(r){if(r.result==="success"){location.href=r.redirect}else{document.getElementById("checkout-error").textContent=r.messages}})})</script>';
		return ob_get_clean();
	}
);

// ---------------------------------------------------------------- webhooks ----------------------
function standin_fire_webhooks( $topic, $payload ) {
	foreach ( standin_all( 'webhooks' ) as $hook ) {
		if ( 'active' !== $hook['status'] || $hook['topic'] !== $topic ) {
			continue;
		}
		standin_deliver( $hook, $topic, wp_json_encode( $payload ), isset( $payload['id'] ) ? $payload['id'] : 0 );
	}
}

/** Delivery like WC_Webhook::deliver(): signed, logged; 5 failures in a row pause the webhook. */
function standin_deliver( $hook, $topic, $body, $resource_id, $content_type = 'application/json' ) {
	$delivery = standin_put( 'deliveries', null, array( 'webhook' => $hook['id'], 'topic' => $topic, 'at' => gmdate( 'c' ) ) );
	list( $resource, $event ) = explode( '.', $topic . '.' );
	$response = wp_remote_post(
		$hook['delivery_url'],
		array(
			'timeout' => 10, 'redirection' => 0, 'body' => $body,
			'headers' => array(
				'Content-Type' => $content_type, 'X-WC-Webhook-Source' => home_url( '/' ), 'X-WC-Webhook-Topic' => $topic, 'X-WC-Webhook-Resource' => $resource,
				'X-WC-Webhook-Event' => $event, 'X-WC-Webhook-Signature' => base64_encode( hash_hmac( 'sha256', $body, $hook['secret'], true ) ),
				'X-WC-Webhook-ID' => $hook['id'], 'X-WC-Webhook-Delivery-ID' => $delivery,
			),
		)
	);
	$code = is_wp_error( $response ) ? 0 : (int) wp_remote_retrieve_response_code( $response );
	$hook = standin_get( 'webhooks', $hook['id'] );
	if ( $code >= 200 && $code < 300 ) {
		$hook['failure_count'] = 0;
	} else {
		$hook['failure_count'] = (int) $hook['failure_count'] + 1;
		if ( $hook['failure_count'] > 5 ) {
			$hook['status'] = 'disabled';
		}
	}
	standin_put( 'webhooks', $hook['id'], $hook );
	return $code;
}

// What the Fullfilio Connect plugin's health report reads.
class WC_Data_Store {
	public static function load( $type ) {
		return new class() {
			public function search_webhooks( $args = array() ) {
				return wp_list_pluck( standin_all( 'webhooks' ), 'id' );
			}
		};
	}
}
function wc_get_webhook( $id ) {
	$h = standin_get( 'webhooks', $id );
	return $h ? new class( $h ) {
		private $h;
		public function __construct( $h ) {
			$this->h = $h;
		}
		public function get_delivery_url() {
			return $this->h['delivery_url'];
		}
		public function get_topic() {
			return $this->h['topic'];
		}
		public function get_status() {
			return $this->h['status'];
		}
		public function get_failure_count() {
			return $this->h['failure_count'];
		}
	} : null;
}

// ---------------------------------------------------------------- API keys + wc-auth ------------
/** Like WC_REST_Authentication: keys authenticate requests WooCommerce considers its REST API. */
add_filter(
	'determine_current_user',
	static function ( $user ) {
		if ( $user ) {
			return $user;
		}
		$uri = isset( $_SERVER['REQUEST_URI'] ) ? wp_unslash( $_SERVER['REQUEST_URI'] ) : ''; // phpcs:ignore
		$is  = false !== strpos( $uri, '/wp-json/wc/' ) || false !== strpos( $uri, 'rest_route=/wc/' );
		if ( ! apply_filters( 'woocommerce_rest_is_request_to_rest_api', $is ) ) {
			return $user;
		}
		$ck = $cs = '';
		if ( ! empty( $_SERVER['PHP_AUTH_USER'] ) ) {
			$ck = wp_unslash( $_SERVER['PHP_AUTH_USER'] ); // phpcs:ignore
			$cs = isset( $_SERVER['PHP_AUTH_PW'] ) ? wp_unslash( $_SERVER['PHP_AUTH_PW'] ) : ''; // phpcs:ignore
		} elseif ( ! empty( $_SERVER['HTTP_AUTHORIZATION'] ) && 0 === stripos( $_SERVER['HTTP_AUTHORIZATION'], 'basic ' ) ) { // phpcs:ignore
			list( $ck, $cs ) = array_pad( explode( ':', base64_decode( substr( $_SERVER['HTTP_AUTHORIZATION'], 6 ) ), 2 ), 2, '' ); // phpcs:ignore
		} elseif ( ! empty( $_GET['consumer_key'] ) ) { // phpcs:ignore
			$ck = wp_unslash( $_GET['consumer_key'] ); // phpcs:ignore
			$cs = isset( $_GET['consumer_secret'] ) ? wp_unslash( $_GET['consumer_secret'] ) : ''; // phpcs:ignore
		}
		if ( ! $ck ) {
			return $user;
		}
		foreach ( standin_all( 'keys' ) as $k ) {
			if ( hash_equals( $k['consumer_key'], $ck ) && hash_equals( $k['consumer_secret'], $cs ) ) {
				return (int) $k['user_id'];
			}
		}
		return $user;
	},
	20
);

// Apache drops the Authorization header unless asked; WooCommerce sites usually have this rule too.
add_action(
	'init',
	static function () {
		if ( empty( $_SERVER['HTTP_AUTHORIZATION'] ) && ! empty( $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ) ) {
			$_SERVER['HTTP_AUTHORIZATION'] = $_SERVER['REDIRECT_HTTP_AUTHORIZATION']; // phpcs:ignore
		}
	},
	0
);

/** /wc-auth/v1/authorize: log in, approve, keys are POSTed to callback_url, back to return_url. */
add_action(
	'parse_request',
	static function () {
		$uri = isset( $_SERVER['REQUEST_URI'] ) ? wp_unslash( $_SERVER['REQUEST_URI'] ) : ''; // phpcs:ignore
		if ( false === strpos( $uri, '/wc-auth/v1/' ) ) {
			return;
		}
		// phpcs:disable WordPress.Security.NonceVerification
		$q = array();
		foreach ( array( 'app_name', 'scope', 'user_id', 'return_url', 'callback_url' ) as $k ) {
			$q[ $k ] = isset( $_REQUEST[ $k ] ) ? wp_unslash( $_REQUEST[ $k ] ) : ''; // phpcs:ignore
		}
		if ( ! is_user_logged_in() ) {
			wp_safe_redirect( wp_login_url( home_url( $uri ) ) );
			exit;
		}
		if ( false !== strpos( $uri, '/wc-auth/v1/access_granted' ) && isset( $_POST['approve'] ) && check_admin_referer( 'wc_auth_grant_access' ) ) {
			$key = array( 'user_id' => get_current_user_id(), 'consumer_key' => 'ck_' . bin2hex( random_bytes( 20 ) ), 'consumer_secret' => 'cs_' . bin2hex( random_bytes( 20 ) ), 'permissions' => $q['scope'], 'description' => $q['app_name'] );
			$key_id = standin_put( 'keys', null, $key );
			$r = wp_remote_post( $q['callback_url'], array( 'timeout' => 30, 'headers' => array( 'Content-Type' => 'application/json' ),
				'body' => wp_json_encode( array( 'key_id' => $key_id, 'user_id' => $q['user_id'], 'consumer_key' => $key['consumer_key'], 'consumer_secret' => $key['consumer_secret'], 'key_permissions' => $q['scope'] ) ) ) );
			if ( is_wp_error( $r ) || wp_remote_retrieve_response_code( $r ) >= 300 ) {
				standin_remove( 'keys', $key_id );
				wp_die( 'An error occurred in the request and at the time were unable to send the consumer data: ' . esc_html( is_wp_error( $r ) ? $r->get_error_message() : wp_remote_retrieve_body( $r ) ) );
			}
			wp_redirect( add_query_arg( array( 'success' => 1, 'user_id' => $q['user_id'] ), $q['return_url'] ) ); // phpcs:ignore WordPress.Security.SafeRedirect
			exit;
		}
		// phpcs:enable
		echo '<!doctype html><title>Approve ' . esc_html( $q['app_name'] ) . '</title><h1>' . esc_html( $q['app_name'] ) . ' would like to connect to your store</h1><p>This will give "' . esc_html( $q['app_name'] ) . '" Read/Write access.</p>';
		echo '<form method="post" action="' . esc_url( home_url( '/wc-auth/v1/access_granted/?' . http_build_query( $q ) ) ) . '">';
		wp_nonce_field( 'wc_auth_grant_access' );
		echo '<button name="approve" value="1" id="wc-auth-approve">Approve</button></form>';
		exit;
	}
);

// ---------------------------------------------------------------- wc/v3 REST --------------------
function standin_can() {
	return current_user_can( 'manage_options' ) ? true : new WP_Error( 'woocommerce_rest_cannot_view', 'Sorry, you cannot list resources.', array( 'status' => rest_authorization_required_code() ) );
}

function standin_product_rest( $p, $variation = null ) {
	if ( $variation ) {
		return array( 'id' => $variation['id'], 'sku' => $variation['sku'], 'price' => $variation['price'], 'regular_price' => $variation['price'], 'sale_price' => '', 'manage_stock' => $variation['manage_stock'],
			'stock_quantity' => $variation['stock_quantity'], 'image' => null, 'attributes' => $variation['attributes'], 'meta_data' => array() );
	}
	$out = $p;
	unset( $out['variations'] );
	return array_merge( $out, array( 'regular_price' => $p['price'], 'sale_price' => '', 'images' => array(), 'description' => '', 'short_description' => '', 'tags' => array(), 'categories' => array(), 'meta_data' => array() ) );
}

add_action(
	'rest_api_init',
	static function () {
		$ns = 'wc/v3';
		register_rest_route( $ns, '/orders', array(
			'methods' => 'GET', 'permission_callback' => 'standin_can',
			'callback' => static function ( WP_REST_Request $r ) {
				$after = $r->get_param( 'after' );
				$list  = array();
				foreach ( standin_all( 'orders' ) as $o ) {
					if ( $after && strtotime( $o['date_created_gmt'] . 'Z' ) < strtotime( $after ) ) {
						continue;
					}
					$list[] = standin_order_rest( new WC_Order( $o ) );
				}
				$per  = max( 1, (int) ( $r->get_param( 'per_page' ) ? $r->get_param( 'per_page' ) : 10 ) );
				$page = max( 1, (int) ( $r->get_param( 'page' ) ? $r->get_param( 'page' ) : 1 ) );
				return array_slice( $list, ( $page - 1 ) * $per, $per );
			},
		) );
		register_rest_route( $ns, '/orders/(?P<id>\d+)', array(
			array( 'methods' => 'GET', 'permission_callback' => 'standin_can', 'callback' => static function ( $r ) {
				$o = wc_get_order( (int) $r['id'] );
				return $o ? standin_order_rest( $o ) : new WP_Error( 'woocommerce_rest_shop_order_invalid_id', 'Invalid ID.', array( 'status' => 404 ) );
			} ),
			array( 'methods' => 'PUT', 'permission_callback' => 'standin_can', 'callback' => static function ( $r ) {
				$o = wc_get_order( (int) $r['id'] );
				if ( ! $o ) {
					return new WP_Error( 'woocommerce_rest_shop_order_invalid_id', 'Invalid ID.', array( 'status' => 404 ) );
				}
				$status = $r->get_param( 'status' );
				if ( $status ) {
					// Like the REST schema: the status must be one WooCommerce knows (plugins add theirs with wc_order_statuses).
					$known = array_map( static function ( $k ) { return preg_replace( '/^wc-/', '', $k ); }, array_keys( wc_get_order_statuses() ) );
					if ( ! in_array( $status, $known, true ) ) {
						return new WP_Error( 'rest_invalid_param', 'Invalid parameter(s): status', array( 'status' => 400, 'params' => array( 'status' => 'status is not one of ' . implode( ', ', $known ) . '.' ) ) );
					}
					$o->set_status_and_save( $status );
				}
				return standin_order_rest( wc_get_order( (int) $r['id'] ) );
			} ),
		) );
		register_rest_route( $ns, '/orders/(?P<id>\d+)/notes', array(
			array( 'methods' => 'GET', 'permission_callback' => 'standin_can', 'callback' => static function ( $r ) {
				return array_values( array_filter( standin_all( 'notes' ), static function ( $n ) use ( $r ) { return (int) $n['order_id'] === (int) $r['id']; } ) );
			} ),
			array( 'methods' => 'POST', 'permission_callback' => 'standin_can', 'callback' => static function ( $r ) {
				$id = standin_put( 'notes', null, array( 'order_id' => (int) $r['id'], 'note' => (string) $r->get_param( 'note' ), 'customer_note' => (bool) $r->get_param( 'customer_note' ) ) );
				return array( 'id' => $id, 'note' => (string) $r->get_param( 'note' ) );
			} ),
		) );
		register_rest_route( $ns, '/webhooks', array(
			array( 'methods' => 'GET', 'permission_callback' => 'standin_can', 'callback' => static function () {
				return array_map( static function ( $h ) { unset( $h['secret'] ); return $h; }, standin_all( 'webhooks' ) );
			} ),
			array( 'methods' => 'POST', 'permission_callback' => 'standin_can', 'callback' => static function ( $r ) {
				$hook = array( 'name' => (string) $r->get_param( 'name' ), 'topic' => (string) $r->get_param( 'topic' ), 'delivery_url' => (string) $r->get_param( 'delivery_url' ),
					'secret' => (string) $r->get_param( 'secret' ), 'status' => $r->get_param( 'status' ) ? (string) $r->get_param( 'status' ) : 'active', 'failure_count' => 0 );
				$hook['id'] = standin_put( 'webhooks', null, $hook );
				// WooCommerce pings a new webhook with webhook_id=<id> (form data).
				standin_deliver( $hook, $hook['topic'], 'webhook_id=' . $hook['id'], 0, 'application/x-www-form-urlencoded' );
				unset( $hook['secret'] );
				return $hook;
			} ),
		) );
		register_rest_route( $ns, '/webhooks/(?P<id>\d+)', array(
			array( 'methods' => 'PUT', 'permission_callback' => 'standin_can', 'callback' => static function ( $r ) {
				$hook = standin_get( 'webhooks', (int) $r['id'] );
				if ( ! $hook ) {
					return new WP_Error( 'woocommerce_rest_webhook_invalid_id', 'Invalid ID.', array( 'status' => 404 ) );
				}
				foreach ( array( 'secret', 'status', 'delivery_url', 'name' ) as $k ) {
					if ( null !== $r->get_param( $k ) ) {
						$hook[ $k ] = (string) $r->get_param( $k );
					}
				}
				if ( 'active' === $hook['status'] ) {
					$hook['failure_count'] = 0;
				}
				standin_put( 'webhooks', $hook['id'], $hook );
				unset( $hook['secret'] );
				return $hook;
			} ),
			array( 'methods' => 'DELETE', 'permission_callback' => 'standin_can', 'callback' => static function ( $r ) {
				standin_remove( 'webhooks', (int) $r['id'] );
				return array( 'id' => (int) $r['id'] );
			} ),
		) );
		register_rest_route( $ns, '/products', array( 'methods' => 'GET', 'permission_callback' => 'standin_can', 'callback' => static function () {
			return array_map( 'standin_product_rest', array_reverse( standin_all( 'products' ) ) );
		} ) );
		register_rest_route( $ns, '/products/(?P<id>\d+)', array(
			array( 'methods' => 'GET', 'permission_callback' => 'standin_can', 'callback' => static function ( $r ) {
				$p = standin_get( 'products', (int) $r['id'] );
				return $p ? standin_product_rest( $p ) : new WP_Error( 'woocommerce_rest_product_invalid_id', 'Invalid ID.', array( 'status' => 404 ) );
			} ),
			array( 'methods' => 'PUT', 'permission_callback' => 'standin_can', 'callback' => static function ( $r ) {
				$p = standin_get( 'products', (int) $r['id'] );
				if ( null !== $r->get_param( 'stock_quantity' ) ) {
					$p['manage_stock']   = true;
					$p['stock_quantity'] = (int) $r->get_param( 'stock_quantity' );
				}
				standin_put( 'products', $p['id'], $p );
				standin_fire_webhooks( 'product.updated', standin_product_rest( $p ) );
				return standin_product_rest( $p );
			} ),
		) );
		register_rest_route( $ns, '/products/(?P<id>\d+)/variations', array( 'methods' => 'GET', 'permission_callback' => 'standin_can', 'callback' => static function ( $r ) {
			$p = standin_get( 'products', (int) $r['id'] );
			return array_map( static function ( $v ) use ( $p ) { return standin_product_rest( $p, $v ); }, $p ? $p['variations'] : array() );
		} ) );
		register_rest_route( $ns, '/products/(?P<pid>\d+)/variations/(?P<id>\d+)', array(
			array( 'methods' => array( 'GET', 'PUT' ), 'permission_callback' => 'standin_can', 'callback' => static function ( $r ) {
				$p = standin_get( 'products', (int) $r['pid'] );
				foreach ( $p['variations'] as $i => $v ) {
					if ( (int) $v['id'] === (int) $r['id'] ) {
						if ( 'PUT' === $r->get_method() && null !== $r->get_param( 'stock_quantity' ) ) {
							$p['variations'][ $i ]['manage_stock']   = true;
							$p['variations'][ $i ]['stock_quantity'] = (int) $r->get_param( 'stock_quantity' );
							standin_put( 'products', $p['id'], $p );
							standin_fire_webhooks( 'product.updated', array_merge( standin_product_rest( $p, $p['variations'][ $i ] ), array( 'parent_id' => $p['id'] ) ) );
						}
						return standin_product_rest( $p, $p['variations'][ $i ] );
					}
				}
				return new WP_Error( 'woocommerce_rest_product_variation_invalid_id', 'Invalid ID.', array( 'status' => 404 ) );
			} ),
		) );
	}
);
