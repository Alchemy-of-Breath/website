<?php
/**
 * AoB Pages Proxy — standalone snippet
 *
 * Same behaviour as the aob-pages-proxy plugin, in a form you can paste into
 * a snippet manager (Code Snippets → Add New → Run everywhere → Save & Activate).
 *
 * Use EITHER the plugin OR this snippet, never both at once — two copies would
 * declare the same functions and WordPress would fatal on a duplicate name.
 *
 * Generated from wordpress-plugin/aob-pages-proxy/aob-pages-proxy.php.
 * Edit that file and regenerate; don't hand-edit this one.
 */

/**
 * Runs before WordPress renders anything. If the requested path is one of
 * ours, fetch the page from the Pages deployment and serve it as-is.
 * On any fetch problem we simply return, and WordPress serves whatever it
 * would have served without the plugin.
 */
add_action( 'template_redirect', 'aob_pages_proxy_serve', 0 );

add_filter( 'old_slug_redirect_url', 'aob_pages_proxy_keep_our_slugs' );

function aob_pages_proxy_keep_our_slugs( $url ) {
	$ours = array( 'alchemy-regulation-method' );
	$path = wp_parse_url( isset( $_SERVER['REQUEST_URI'] ) ? $_SERVER['REQUEST_URI'] : '/', PHP_URL_PATH );
	return ( is_string( $path ) && in_array( trim( $path, '/' ), $ours, true ) ) ? '' : $url;
}

function aob_pages_proxy_serve() {

	$origin = 'https://website-5h3.pages.dev';

	// WordPress path (no slashes)  =>  path on the Pages deployment.
	// Add or remove pages here — one line per page.
	$routes = array(
		'about'                => '/about/',
		'the-alchemist'        => '/the-alchemist/',
		'refer'                => '/refer/',
		'breathcamps'          => '/breathcamps/',
		'breathcamps/guide'    => '/breathcamps/guide/',
		'calendar'             => '/calendar/',
		'alchemy-regulation-method' => '/arm/',
		'masterclass'          => '/masterclass/',
		'legacy-scholarship'   => '/legacy-scholarship/',
		'breathwork-training'  => '/facilitator-training/',
		'live-residential-breathwork-facilitator-training' => '/live-residential-breathwork-facilitator-training/',
	);

	// Old URLs that now live somewhere else. Redirected so search engines and
	// links consolidate on the one canonical address.
	$redirects = array(
		'facilitator-training' => '/breathwork-training/',
		'arm'                  => '/alchemy-regulation-method/',
	);

	$request_uri = isset( $_SERVER['REQUEST_URI'] ) ? $_SERVER['REQUEST_URI'] : '/';
	$path        = wp_parse_url( $request_uri, PHP_URL_PATH );
	if ( ! is_string( $path ) ) {
		return;
	}
	$key = trim( $path, '/' );

	if ( isset( $redirects[ $key ] ) ) {
		$query = wp_parse_url( $request_uri, PHP_URL_QUERY );
		$to    = home_url( $redirects[ $key ] );
		if ( $query ) {
			$to .= '?' . $query;
		}
		wp_redirect( $to, 301 );
		exit;
	}

	if ( isset( $routes[ $key ] ) ) {
		// One of our pages.
		$upstream = $origin . $routes[ $key ];
		$is_html  = true;
	} elseif ( 0 === strpos( $path, '/assets/' ) ) {
		// Images/media the pages load from /assets/… — proxy those too.
		$upstream = $origin . $path;
		$is_html  = false;
	} else {
		return; // Everything else stays 100% WordPress.
	}

	$response = wp_remote_get(
		$upstream,
		array(
			'timeout'     => 20,
			'redirection' => 3,
			'user-agent'  => 'AoB-Pages-Proxy/1.0 (+' . home_url( '/' ) . ')',
		)
	);

	if ( is_wp_error( $response ) || 200 !== wp_remote_retrieve_response_code( $response ) ) {
		return; // Graceful fallback: let WordPress handle the request.
	}

	$body = wp_remote_retrieve_body( $response );
	$type = wp_remote_retrieve_header( $response, 'content-type' );
	if ( empty( $type ) ) {
		$type = $is_html ? 'text/html; charset=utf-8' : 'application/octet-stream';
	}

	if ( $is_html ) {
		// If any absolute deployment URL sneaks into a page, keep visitors on this domain.
		$body = str_replace( 'https://website-5h3.pages.dev/', home_url( '/' ), $body );
	}

	status_header( 200 );
	header( 'Content-Type: ' . $type );
	header( 'Cache-Control: public, max-age=600' );
	header( 'X-AoB-Proxy: pages' );

	echo $body; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- full trusted document passthrough.
	exit;
}
