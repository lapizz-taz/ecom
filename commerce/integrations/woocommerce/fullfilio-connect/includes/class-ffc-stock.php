<?php
/**
 * Stock.
 *
 * Who keeps the count:
 * - "Stock sync" on in Fullfilio: Fullfilio keeps the count and writes it here.
 *   WooCommerce still takes items off when an order is placed (so the shop
 *   never oversells between updates), but it does not put them back on a
 *   cancel: Fullfilio has already put them back on its side and sends the
 *   count, so doing it here as well would count them twice.
 * - Stock sync off: WooCommerce keeps its own count. A cancel puts items back
 *   the WooCommerce way. Items that came back to Fullfilio as good (a return,
 *   the undelivered part of a partial delivery) are put back by restock().
 *
 * restock() never adds more than WooCommerce took off for an order line, and
 * remembers per line what it already put back, so a retried update or a second
 * partial return adds only the difference.
 */

defined( 'ABSPATH' ) || exit;

class FFC_Stock {
	const LOG     = 'ffc_stock_log';
	const LOG_MAX = 200;

	public static function init() {
		add_filter( 'woocommerce_can_restore_order_stock', array( __CLASS__, 'can_restore' ), 20, 2 );
	}

	/** Fullfilio keeps this store's stock (Stock sync on in Fullfilio). */
	public static function managed_by_fullfilio() {
		return FFC_Settings::enabled( 'stock_sync' );
	}

	/** WooCommerce's own restock on cancel is skipped when Fullfilio keeps the count. */
	public static function can_restore( $can, $order = null ) {
		if ( $can && self::managed_by_fullfilio() ) {
			if ( $order instanceof WC_Order && ! $order->get_meta( '_ffc_no_restore_note' ) ) {
				$order->add_order_note( 'Stock not put back here: Fullfilio keeps this store\'s stock and sends the count.' );
				$order->update_meta_data( '_ffc_no_restore_note', 1 );
				$order->save();
			}
			return false;
		}
		return $can;
	}

	/**
	 * Puts back items that came back to Fullfilio for one order.
	 *
	 * @param WC_Order $order
	 * @param array    $lines  [{external_variant_id?, sku?, name?, quantity}] quantity = total back so far for that line
	 * @param string   $reason "return" or "partial delivery"
	 * @return array<int, array{name:string,added:int,stock:int|null,skipped?:string}>
	 */
	public static function restock( $order, $lines, $reason ) {
		$out = array();
		if ( ! $order ) {
			return $out;
		}
		if ( self::managed_by_fullfilio() ) {
			return array( array( 'name' => '', 'added' => 0, 'stock' => null, 'skipped' => 'Fullfilio keeps the stock' ) );
		}
		$items = $order->get_items();
		$used  = array();
		foreach ( $lines as $line ) {
			$want = isset( $line['quantity'] ) ? max( 0, (int) $line['quantity'] ) : 0;
			$item = self::match( $items, $line, $used );
			$name = isset( $line['name'] ) ? sanitize_text_field( (string) $line['name'] ) : '';
			if ( ! $item ) {
				$out[] = array( 'name' => $name, 'added' => 0, 'stock' => null, 'skipped' => 'not on this order' );
				continue;
			}
			$used[]  = $item->get_id();
			$product = $item->get_product();
			$name    = $item->get_name();
			if ( ! $product || ! $product->managing_stock() ) {
				$out[] = array( 'name' => $name, 'added' => 0, 'stock' => null, 'skipped' => 'stock not tracked' );
				continue;
			}
			$done    = (int) $item->get_meta( '_ffc_restocked', true );
			$reduced = (int) $item->get_meta( '_reduced_stock', true );
			// Up to the line's quantity, minus what was already put back, within what WooCommerce took off.
			$add = min( $want, (int) $item->get_quantity() ) - $done;
			$add = min( $add, $reduced );
			if ( $add <= 0 ) {
				$out[] = array( 'name' => $name, 'added' => 0, 'stock' => $product->get_stock_quantity(), 'skipped' => $reduced <= 0 && $want > $done ? 'WooCommerce did not take this off' : 'already put back' );
				continue;
			}
			$new = wc_update_product_stock( $product, $add, 'increase' );
			$item->update_meta_data( '_ffc_restocked', $done + $add );
			// WooCommerce's own restock (e.g. a later cancel) must not add these again.
			$item->update_meta_data( '_reduced_stock', $reduced - $add );
			$item->save();
			$order->add_order_note( sprintf( 'Fullfilio: %1$d × %2$s put back in stock (%3$s). Stock now %4$s.', $add, $name, $reason, null === $new ? '?' : $new ) );
			self::log( array( 'order' => $order->get_order_number(), 'order_id' => $order->get_id(), 'product' => $name, 'sku' => $product->get_sku(), 'added' => $add, 'stock' => $new, 'reason' => $reason ) );
			$out[] = array( 'name' => $name, 'added' => $add, 'stock' => $new );
		}
		return $out;
	}

	/** The order line for one of Fullfilio's lines: store id, then SKU, then name. */
	private static function match( $items, $line, $used ) {
		$id   = isset( $line['external_variant_id'] ) ? (string) $line['external_variant_id'] : '';
		$sku  = isset( $line['sku'] ) ? (string) $line['sku'] : '';
		$name = isset( $line['name'] ) ? strtolower( trim( (string) $line['name'] ) ) : '';
		foreach ( array( 'id', 'sku', 'name' ) as $by ) {
			foreach ( $items as $item ) {
				if ( ! $item instanceof WC_Order_Item_Product || in_array( $item->get_id(), $used, true ) ) {
					continue;
				}
				$pid = (string) ( $item->get_variation_id() ? $item->get_variation_id() : $item->get_product_id() );
				$p   = $item->get_product();
				if ( ( 'id' === $by && '' !== $id && $pid === $id )
					|| ( 'sku' === $by && '' !== $sku && $p && $p->get_sku() === $sku )
					|| ( 'name' === $by && '' !== $name && 0 === strpos( strtolower( $item->get_name() ), $name ) ) ) {
					return $item;
				}
			}
		}
		return null;
	}

	public static function log( $entry ) {
		$log = get_option( self::LOG, array() );
		$log = is_array( $log ) ? $log : array();
		array_unshift( $log, array_merge( array( 'at' => gmdate( 'Y-m-d H:i:s' ) ), $entry ) );
		update_option( self::LOG, array_slice( $log, 0, self::LOG_MAX ), false );
	}

	public static function recent( $n = 20 ) {
		$log = get_option( self::LOG, array() );
		return array_slice( is_array( $log ) ? $log : array(), 0, $n );
	}

	/** Stock overview for the plugin page. */
	public static function summary( $low_limit = 15 ) {
		$threshold = (int) get_option( 'woocommerce_notify_low_stock_amount', 2 );
		$out       = array( 'tracked' => 0, 'out' => 0, 'low' => 0, 'low_items' => array(), 'threshold' => $threshold );
		if ( ! function_exists( 'wc_get_products' ) ) {
			return $out;
		}
		$products = wc_get_products( array( 'limit' => 500, 'status' => array( 'publish', 'private' ), 'type' => array( 'simple', 'variable' ), 'return' => 'objects' ) );
		$all      = array();
		foreach ( $products as $p ) {
			if ( $p->is_type( 'variable' ) ) {
				foreach ( $p->get_children() as $child_id ) {
					$c = wc_get_product( $child_id );
					if ( $c ) {
						$all[] = $c;
					}
				}
				continue;
			}
			$all[] = $p;
		}
		foreach ( $all as $p ) {
			if ( ! $p->managing_stock() ) {
				continue;
			}
			++$out['tracked'];
			$q = (int) $p->get_stock_quantity();
			if ( $q <= 0 ) {
				++$out['out'];
			} elseif ( $q <= $threshold ) {
				++$out['low'];
			}
			if ( $q <= $threshold && count( $out['low_items'] ) < $low_limit ) {
				$out['low_items'][] = array( 'name' => $p->get_name(), 'sku' => $p->get_sku(), 'stock' => $q, 'edit' => get_edit_post_link( $p->get_parent_id() ? $p->get_parent_id() : $p->get_id(), 'raw' ) );
			}
		}
		return $out;
	}
}
