<?php
/**
 * Signatures on everything sent to Fullfilio: HMAC-SHA256 of
 * "<unix timestamp>.<raw body>" with the connection secret, base64. Fullfilio
 * refuses a request whose timestamp is more than five minutes off, so a
 * recorded request cannot be replayed later.
 */

defined( 'ABSPATH' ) || exit;

class FFC_Signer {
	const SKEW = 300;

	public static function sign( $secret, $timestamp, $body ) {
		return base64_encode( hash_hmac( 'sha256', $timestamp . '.' . $body, $secret, true ) );
	}

	public static function verify( $secret, $timestamp, $body, $signature, $now = null ) {
		$now = null === $now ? time() : (int) $now;
		if ( ! ctype_digit( (string) $timestamp ) || abs( $now - (int) $timestamp ) > self::SKEW || '' === (string) $signature ) {
			return false;
		}
		return hash_equals( self::sign( $secret, (string) $timestamp, $body ), (string) $signature );
	}

	/** A random v4 UUID (wp_generate_uuid4 when WordPress has it). */
	public static function uuid() {
		if ( function_exists( 'wp_generate_uuid4' ) ) {
			return wp_generate_uuid4();
		}
		$b    = random_bytes( 16 );
		$b[6] = chr( ord( $b[6] ) & 0x0f | 0x40 );
		$b[8] = chr( ord( $b[8] ) & 0x3f | 0x80 );
		return vsprintf( '%s%s-%s-%s-%s-%s%s%s', str_split( bin2hex( $b ), 4 ) );
	}
}
