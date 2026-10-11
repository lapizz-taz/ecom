<?php
/**
 * Small daily counters for the plugin dashboard: orders and their value,
 * unfinished checkouts sent, and checkouts stopped or flagged by protection.
 * One option, at most 60 days, counted from the day the plugin was installed.
 */

defined( 'ABSPATH' ) || exit;

class FFC_Stats {
	const OPTION = 'ffc_daily';
	const DAYS   = 60;
	const KEYS   = array( 'orders', 'revenue', 'leads', 'blocked', 'flagged' );

	public static function init() {
		add_action( 'woocommerce_new_order', array( __CLASS__, 'order' ), 30, 2 );
	}

	public static function order( $order_id, $order = null ) {
		$order = $order instanceof WC_Order ? $order : wc_get_order( $order_id );
		if ( ! $order || 'shop_order_refund' === $order->get_type() ) {
			return;
		}
		self::bump( 'orders', 1 );
		self::bump( 'revenue', (float) $order->get_total() );
	}

	/** Adds $by to today's counter (site time zone). */
	public static function bump( $key, $by = 1 ) {
		if ( ! in_array( $key, self::KEYS, true ) ) {
			return;
		}
		$all = self::all();
		$day = wp_date( 'Y-m-d' );
		if ( ! isset( $all[ $day ] ) ) {
			$all[ $day ] = array_fill_keys( self::KEYS, 0 );
		}
		$all[ $day ][ $key ] = round( (float) $all[ $day ][ $key ] + $by, 2 );
		ksort( $all );
		update_option( self::OPTION, array_slice( $all, -self::DAYS, null, true ), false );
	}

	public static function all() {
		$all = get_option( self::OPTION, array() );
		return is_array( $all ) ? $all : array();
	}

	/**
	 * The last $days days, oldest first, with zeros for quiet days.
	 *
	 * @return array<int, array{day:string,orders:float,revenue:float,leads:float,blocked:float,flagged:float}>
	 */
	public static function series( $days = 14, $offset = 0 ) {
		$all = self::all();
		$out = array();
		for ( $i = $days - 1 + $offset; $i >= $offset; $i-- ) {
			$day   = wp_date( 'Y-m-d', time() - $i * DAY_IN_SECONDS );
			$out[] = array_merge( array( 'day' => $day ), array_fill_keys( self::KEYS, 0 ), isset( $all[ $day ] ) ? $all[ $day ] : array() );
		}
		return $out;
	}

	/** Sum of one counter over the last $days days (or the $days before that, with $offset = $days). */
	public static function total( $key, $days = 7, $offset = 0 ) {
		return array_sum( wp_list_pluck( self::series( $days, $offset ), $key ) );
	}
}
