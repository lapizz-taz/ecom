<?php
/**
 * Updates from Fullfilio, the WordPress way: when a new version is published,
 * Plugins and Dashboard → Updates show "There is a new version of Fullfilio
 * Connect available" with "Update now", "View details" and auto-updates.
 *
 * The version list is a small JSON manifest next to the plugin download
 * (https://fullfilio.com/downloads/fullfilio-connect.json, written by
 * scripts/build-woo-plugin.mjs). Safety:
 *  - the manifest and the package are fetched over HTTPS only, the package
 *    from the same host as the manifest, without following redirects;
 *  - the downloaded zip must match the manifest's SHA-256 or it is not
 *    installed.
 */

defined( 'ABSPATH' ) || exit;

class FFC_Updater {
	const MANIFEST = 'https://fullfilio.com/downloads/fullfilio-connect.json';
	const SLUG     = 'fullfilio-connect';
	const CACHE    = 'ffc_update_manifest';

	public static function init() {
		add_filter( 'pre_set_site_transient_update_plugins', array( __CLASS__, 'inject' ) );
		// Also when the list is read: WordPress skips saving it when wordpress.org cannot be reached.
		add_filter( 'site_transient_update_plugins', array( __CLASS__, 'inject' ) );
		add_filter( 'plugins_api', array( __CLASS__, 'info' ), 20, 3 );
		add_filter( 'upgrader_pre_download', array( __CLASS__, 'verify_download' ), 10, 4 );
		add_action( 'upgrader_process_complete', array( __CLASS__, 'purge' ), 10, 0 );
		add_filter( 'plugin_row_meta', array( __CLASS__, 'row_meta' ), 10, 2 );
		add_action( 'admin_post_ffc_check_update', array( __CLASS__, 'handle_check' ) );
	}

	public static function manifest_url() {
		return (string) apply_filters( 'ffc_update_manifest_url', defined( 'FFC_UPDATE_URL' ) ? FFC_UPDATE_URL : self::MANIFEST );
	}

	/** HTTPS only (plain HTTP just for the offline test store, which defines FFC_ALLOW_HTTP). */
	private static function allowed( $url ) {
		$scheme = wp_parse_url( (string) $url, PHP_URL_SCHEME );
		return 'https' === $scheme || ( 'http' === $scheme && defined( 'FFC_ALLOW_HTTP' ) && FFC_ALLOW_HTTP );
	}

	/**
	 * The published version info, or null when it cannot be read.
	 *
	 * @return array|null
	 */
	public static function manifest( $force = false ) {
		$cached = get_site_transient( self::CACHE );
		if ( ! $force && is_array( $cached ) && array_key_exists( 'data', $cached ) ) {
			return $cached['data'];
		}
		$url  = self::manifest_url();
		$data = null;
		if ( self::allowed( $url ) ) {
			$res = wp_remote_get( $url, array( 'timeout' => 10, 'redirection' => 0, 'headers' => array( 'Accept' => 'application/json' ) ) );
			if ( ! is_wp_error( $res ) && 200 === (int) wp_remote_retrieve_response_code( $res ) ) {
				$data = self::clean( json_decode( (string) wp_remote_retrieve_body( $res ), true ), $url );
			}
		}
		// A failed check is retried after an hour, a good one after six.
		set_site_transient( self::CACHE, array( 'data' => $data ), $data ? 6 * HOUR_IN_SECONDS : HOUR_IN_SECONDS );
		return $data;
	}

	/** Keeps only well-formed fields; the package must live on the manifest's own host. */
	private static function clean( $m, $manifest_url ) {
		if ( ! is_array( $m ) || empty( $m['version'] ) || empty( $m['package'] ) || empty( $m['sha256'] ) ) {
			return null;
		}
		$version = (string) $m['version'];
		$package = esc_url_raw( (string) $m['package'] );
		$sha     = strtolower( (string) $m['sha256'] );
		if ( ! preg_match( '/^\d+\.\d+\.\d+$/', $version ) || ! preg_match( '/^[a-f0-9]{64}$/', $sha ) || ! self::allowed( $package )
			|| wp_parse_url( $package, PHP_URL_HOST ) !== wp_parse_url( $manifest_url, PHP_URL_HOST ) ) {
			return null;
		}
		$text = static function ( $k, $max = 20 ) use ( $m ) {
			return isset( $m[ $k ] ) ? substr( sanitize_text_field( (string) $m[ $k ] ), 0, $max ) : '';
		};
		return array(
			'version'      => $version,
			'package'      => $package,
			'sha256'       => $sha,
			'requires'     => $text( 'requires' ),
			'tested'       => $text( 'tested' ),
			'requires_php' => $text( 'requires_php' ),
			'homepage'     => isset( $m['homepage'] ) ? esc_url_raw( (string) $m['homepage'] ) : '',
			'changelog'    => isset( $m['changelog'] ) ? wp_kses_post( (string) $m['changelog'] ) : '',
			'description'  => isset( $m['description'] ) ? wp_kses_post( (string) $m['description'] ) : '',
		);
	}

	/** The newer version, or null when this one is current. */
	public static function available() {
		$m = self::manifest();
		return $m && version_compare( $m['version'], FFC_VERSION, '>' ) ? $m : null;
	}

	private static function item( $m, $current ) {
		return (object) array(
			'id'           => self::SLUG,
			'slug'         => self::SLUG,
			'plugin'       => plugin_basename( FFC_FILE ),
			'new_version'  => $current ? FFC_VERSION : $m['version'],
			'url'          => $m['homepage'],
			'package'      => $current ? '' : $m['package'],
			'requires'     => $m['requires'],
			'tested'       => $m['tested'],
			'requires_php' => $m['requires_php'],
			'icons'        => array(),
		);
	}

	public static function inject( $transient ) {
		if ( ! is_object( $transient ) ) {
			return $transient;
		}
		$m = self::manifest();
		if ( ! $m ) {
			return $transient;
		}
		$file = plugin_basename( FFC_FILE );
		if ( version_compare( $m['version'], FFC_VERSION, '>' ) ) {
			$transient->response        = isset( $transient->response ) && is_array( $transient->response ) ? $transient->response : array();
			$transient->response[ $file ] = self::item( $m, false );
		} else {
			// Listed as up to date, so WordPress offers "Enable auto-updates".
			$transient->no_update        = isset( $transient->no_update ) && is_array( $transient->no_update ) ? $transient->no_update : array();
			$transient->no_update[ $file ] = self::item( $m, true );
			if ( isset( $transient->response[ $file ] ) ) {
				unset( $transient->response[ $file ] );
			}
		}
		return $transient;
	}

	/** "View details" on the Plugins screen. */
	public static function info( $result, $action, $args ) {
		if ( 'plugin_information' !== $action || ! is_object( $args ) || empty( $args->slug ) || self::SLUG !== $args->slug ) {
			return $result;
		}
		$m = self::manifest();
		if ( ! $m ) {
			return $result;
		}
		return (object) array(
			'name'          => 'Fullfilio Connect for WooCommerce',
			'slug'          => self::SLUG,
			'version'       => $m['version'],
			'author'        => 'Fullfilio',
			'homepage'      => $m['homepage'],
			'requires'      => $m['requires'],
			'tested'        => $m['tested'],
			'requires_php'  => $m['requires_php'],
			'download_link' => $m['package'],
			'sections'      => array(
				'description' => $m['description'] ? $m['description'] : '<p>Connects this WooCommerce store to Fullfilio: instant orders, unfinished checkouts, checkout protection, ad tracking and stock.</p>',
				'changelog'   => $m['changelog'],
			),
		);
	}

	/** Downloads our package itself and refuses it unless it matches the published checksum. */
	public static function verify_download( $reply, $package, $upgrader = null, $hook_extra = array() ) {
		$m = self::manifest();
		if ( false !== $reply || ! $m || (string) $package !== $m['package'] ) {
			return $reply;
		}
		if ( ! function_exists( 'download_url' ) ) {
			require_once ABSPATH . 'wp-admin/includes/file.php';
		}
		$tmp = download_url( $package, 300 );
		if ( is_wp_error( $tmp ) ) {
			return $tmp;
		}
		if ( ! hash_equals( $m['sha256'], (string) hash_file( 'sha256', $tmp ) ) ) {
			wp_delete_file( $tmp );
			FFC_Log::warning( 'Update refused: the downloaded package did not match its checksum' );
			return new WP_Error( 'ffc_checksum', __( 'The Fullfilio Connect download did not match its published checksum, so it was not installed. Please try again later.', 'fullfilio-connect' ) );
		}
		return $tmp;
	}

	public static function purge() {
		delete_site_transient( self::CACHE );
	}

	public static function check_url() {
		return wp_nonce_url( admin_url( 'admin-post.php?action=ffc_check_update' ), 'ffc_check_update' );
	}

	public static function update_url() {
		$file = plugin_basename( FFC_FILE );
		return wp_nonce_url( self_admin_url( 'update.php?action=upgrade-plugin&plugin=' . rawurlencode( $file ) ), 'upgrade-plugin_' . $file );
	}

	public static function row_meta( $links, $file ) {
		if ( plugin_basename( FFC_FILE ) === $file && current_user_can( 'update_plugins' ) ) {
			$links[] = '<a href="' . esc_url( self::check_url() ) . '">' . esc_html__( 'Check for updates', 'fullfilio-connect' ) . '</a>';
		}
		return $links;
	}

	public static function handle_check() {
		if ( ! current_user_can( 'update_plugins' ) ) {
			wp_die( esc_html__( 'You are not allowed to do this.', 'fullfilio-connect' ), 403 );
		}
		check_admin_referer( 'ffc_check_update' );
		self::manifest( true );
		delete_site_transient( 'update_plugins' );
		if ( function_exists( 'wp_update_plugins' ) ) {
			wp_update_plugins();
		}
		$m    = self::available();
		$note = $m ? sprintf( 'Version %s is available.', $m['version'] ) : ( self::manifest() ? 'You have the latest version.' : 'Could not reach the update server. Try again later.' );
		wp_safe_redirect( add_query_arg( array( 'page' => 'fullfilio-connect', 'ffc_notice' => rawurlencode( $note ), 'ffc_type' => $m ? 'warning' : 'success' ), admin_url( 'admin.php' ) ) );
		exit;
	}
}
