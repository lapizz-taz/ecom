<?php
/**
 * A short debug log kept in one option (newest first, at most 200 lines), shown
 * on the plugin page and sent with the health report. Never holds secrets or
 * full customer data: callers pass short messages and small context.
 */

defined( 'ABSPATH' ) || exit;

class FFC_Log {
	const OPTION = 'ffc_log';
	const MAX    = 200;

	/**
	 * @param string $level   info | warning | error
	 * @param string $message Short, human readable.
	 * @param array  $context Small, non-secret details.
	 */
	public static function add( $level, $message, $context = array() ) {
		$lines = get_option( self::OPTION, array() );
		if ( ! is_array( $lines ) ) {
			$lines = array();
		}
		array_unshift(
			$lines,
			array(
				'at'      => gmdate( 'c' ),
				'level'   => in_array( $level, array( 'info', 'warning', 'error' ), true ) ? $level : 'info',
				'message' => self::clip( $message, 300 ),
				'context' => self::scrub( $context ),
			)
		);
		update_option( self::OPTION, array_slice( $lines, 0, self::MAX ), false );
		if ( 'error' === $level && function_exists( 'wc_get_logger' ) ) {
			wc_get_logger()->error( $message, array( 'source' => 'fullfilio-connect' ) );
		}
	}

	public static function info( $message, $context = array() ) {
		self::add( 'info', $message, $context );
	}

	public static function warning( $message, $context = array() ) {
		self::add( 'warning', $message, $context );
	}

	public static function error( $message, $context = array() ) {
		self::add( 'error', $message, $context );
	}

	/** @return array<int, array> */
	public static function recent( $limit = 50 ) {
		$lines = get_option( self::OPTION, array() );
		return is_array( $lines ) ? array_slice( $lines, 0, $limit ) : array();
	}

	public static function clear() {
		delete_option( self::OPTION );
	}

	private static function clip( $text, $max ) {
		$text = (string) $text;
		return strlen( $text ) > $max ? substr( $text, 0, $max ) . '…' : $text;
	}

	/** Drops anything that looks like a secret and keeps the rest short. */
	private static function scrub( $context ) {
		if ( ! is_array( $context ) ) {
			return array();
		}
		$out = array();
		foreach ( array_slice( $context, 0, 12, true ) as $key => $value ) {
			if ( preg_match( '/secret|token|password|key|signature|authorization/i', (string) $key ) ) {
				$out[ $key ] = '[hidden]';
			} elseif ( is_scalar( $value ) || null === $value ) {
				$out[ $key ] = is_string( $value ) ? self::clip( $value, 200 ) : $value;
			} else {
				$out[ $key ] = self::clip( wp_json_encode( $value ), 200 );
			}
		}
		return $out;
	}
}
