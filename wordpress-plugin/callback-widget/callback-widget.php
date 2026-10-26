<?php
/**
 * Plugin Name: Callback – oddzwanianie w 30 sekund
 * Description: Widget „Zadzwonimy do Ciebie w 30 sekund”. Wpisz numer telefonu, kliknij „Włącz widget” i gotowe.
 * Version: 2.0.1
 * Requires PHP: 7.4
 * License: GPLv2 or later
 */

if (!defined('ABSPATH')) {
    exit;
}

// Adres serwera Callback (wpisywany automatycznie przy pobieraniu wtyczki z serwera).
if (!defined('CBW_SERVER')) {
    define('CBW_SERVER', 'https://callback.viaregia.online');
}
const CBW_OPTION = 'cbw_settings';

function cbw_get_settings() {
    return wp_parse_args(get_option(CBW_OPTION, []), [
        'site_key' => '',
        'secret'   => '',
        'email'    => '',
        'enabled'  => '1',
        'exclude'  => '',
        'prev_key'    => '',
        'prev_secret' => '',
    ]);
}

function cbw_save_settings($changes) {
    update_option(CBW_OPTION, array_merge(cbw_get_settings(), $changes));
}

function cbw_server() {
    return untrailingslashit(CBW_SERVER);
}

function cbw_api($path, $body) {
    $res = wp_remote_post(cbw_server() . $path, [
        'timeout' => 15,
        'headers' => ['Content-Type' => 'application/json'],
        'body'    => wp_json_encode($body),
    ]);
    if (is_wp_error($res)) {
        return ['ok' => false, 'data' => ['error' => 'Brak połączenia z serwerem Callback: ' . $res->get_error_message()]];
    }
    $code = wp_remote_retrieve_response_code($res);
    $data = json_decode(wp_remote_retrieve_body($res), true);
    return ['ok' => $code >= 200 && $code < 300, 'code' => $code, 'data' => is_array($data) ? $data : []];
}

// ---------- widget na stronie ----------

add_action('wp_footer', function () {
    $s = cbw_get_settings();
    if ($s['enabled'] !== '1' || $s['site_key'] === '') {
        return;
    }
    $path = isset($_SERVER['REQUEST_URI']) ? wp_parse_url(wp_unslash($_SERVER['REQUEST_URI']), PHP_URL_PATH) : '/';
    foreach (array_filter(array_map('trim', explode("\n", $s['exclude']))) as $prefix) {
        if (strpos((string) $path, $prefix) === 0) {
            return;
        }
    }
    printf(
        '<script src="%s/widget.js" data-site="%s" async data-no-optimize="1" data-cfasync="false"></script>' . "\n",
        esc_url(cbw_server()),
        esc_attr($s['site_key'])
    );
}, 100);

// ---------- kokpit ----------

add_action('admin_menu', function () {
    add_menu_page('Callback', 'Callback', 'manage_options', 'cbw', 'cbw_page', 'dashicons-phone', 58);
});

add_filter('plugin_action_links_' . plugin_basename(__FILE__), function ($links) {
    array_unshift($links, '<a href="' . esc_url(admin_url('admin.php?page=cbw')) . '">Ustawienia</a>');
    return $links;
});

// Przypomnienie po aktywacji, dopóki widget nie jest włączony.
add_action('admin_notices', function () {
    $screen = function_exists('get_current_screen') ? get_current_screen() : null;
    if (!current_user_can('manage_options') || cbw_get_settings()['site_key'] !== '' || ($screen && $screen->id === 'toplevel_page_cbw')) {
        return;
    }
    printf(
        '<div class="notice notice-warning"><p><strong>Callback:</strong> został jeden krok. <a href="%s">Wpisz numer telefonu i włącz widget →</a></p></div>',
        esc_url(admin_url('admin.php?page=cbw'))
    );
});

function cbw_redirect($args = []) {
    wp_safe_redirect(add_query_arg($args, admin_url('admin.php?page=cbw')));
    exit;
}

// Włączenie widgetu: zakłada konto i stronę na serwerze Callback.
add_action('admin_post_cbw_connect', function () {
    if (!current_user_can('manage_options')) {
        wp_die('Brak uprawnień');
    }
    check_admin_referer('cbw_connect');
    $email = sanitize_email(wp_unslash($_POST['email'] ?? ''));
    $phone = sanitize_text_field(wp_unslash($_POST['phone'] ?? ''));
    $password = (string) wp_unslash($_POST['password'] ?? '');
    $r = cbw_api('/api/wp/connect', [
        'email'    => $email,
        'phone'    => $phone,
        'password' => $password,
        'siteUrl'  => home_url('/'),
        'siteName' => get_bloginfo('name'),
        'siteKey'  => cbw_get_settings()['prev_key'],
        'secret'   => cbw_get_settings()['prev_secret'],
    ]);
    if (!$r['ok']) {
        set_transient('cbw_form', ['email' => $email, 'phone' => $phone, 'need_password' => !empty($r['data']['needPassword'])], 300);
        cbw_redirect(['cbw_error' => rawurlencode($r['data']['error'] ?? 'Nie udało się włączyć widgetu.')]);
    }
    cbw_save_settings([
        'site_key' => $r['data']['siteKey'],
        'secret'   => $r['data']['secret'],
        'email'    => $email,
        'enabled'  => '1',
    ]);
    cbw_redirect(['cbw_done' => '1']);
});

// „Otwórz panel”: jednorazowy link logowania, bez hasła.
add_action('admin_post_cbw_panel', function () {
    if (!current_user_can('manage_options')) {
        wp_die('Brak uprawnień');
    }
    check_admin_referer('cbw_panel');
    $s = cbw_get_settings();
    $r = cbw_api('/api/wp/login-link', ['siteKey' => $s['site_key'], 'secret' => $s['secret']]);
    if (!$r['ok'] || empty($r['data']['url'])) {
        cbw_redirect(['cbw_error' => rawurlencode($r['data']['error'] ?? 'Nie udało się otworzyć panelu.')]);
    }
    wp_redirect($r['data']['url']); // phpcs:ignore WordPress.Security.SafeRedirect -- adres serwera Callback
    exit;
});

add_action('admin_post_cbw_options', function () {
    if (!current_user_can('manage_options')) {
        wp_die('Brak uprawnień');
    }
    check_admin_referer('cbw_options');
    cbw_save_settings([
        'enabled' => empty($_POST['enabled']) ? '0' : '1',
        'exclude' => sanitize_textarea_field(wp_unslash($_POST['exclude'] ?? '')),
    ]);
    cbw_redirect(['cbw_saved' => '1']);
});

add_action('admin_post_cbw_disconnect', function () {
    if (!current_user_can('manage_options')) {
        wp_die('Brak uprawnień');
    }
    check_admin_referer('cbw_disconnect');
    $s = cbw_get_settings();
    // zapamiętujemy dane, żeby ponowne włączenie nie wymagało hasła
    cbw_save_settings(['site_key' => '', 'secret' => '', 'prev_key' => $s['site_key'], 'prev_secret' => $s['secret']]);
    cbw_redirect();
});

function cbw_page() {
    $s = cbw_get_settings();
    $form = get_transient('cbw_form') ?: [];
    delete_transient('cbw_form');
    $email = $form['email'] ?? ($s['email'] ?: get_option('admin_email'));
    $phone = $form['phone'] ?? '';
    $need_password = !empty($form['need_password']);
    ?>
    <style>
        .cbw{max-width:640px;margin-top:20px}
        .cbw-card{background:#fff;border:1px solid #dcdcde;border-radius:12px;padding:28px 32px;margin-bottom:16px}
        .cbw-card h2{margin:0 0 6px;font-size:22px}
        .cbw-card p.lead{color:#50575e;font-size:14px;margin:0 0 22px}
        .cbw label{display:block;font-weight:600;margin:14px 0 6px}
        .cbw input[type=email],.cbw input[type=tel],.cbw input[type=password]{width:100%;max-width:420px;padding:8px 12px;font-size:15px}
        .cbw .hint{color:#646970;font-size:13px;margin:6px 0 0}
        .cbw .go{background:#7C3AED;border-color:#7C3AED;color:#fff;font-size:15px;padding:8px 24px;height:auto;border-radius:999px;margin-top:22px}
        .cbw .go:hover,.cbw .go:focus{background:#6D28D9;border-color:#6D28D9;color:#fff}
        .cbw-ok{display:flex;align-items:center;gap:10px;font-size:18px;font-weight:600;margin:0 0 6px}
        .cbw-ok span{width:12px;height:12px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 4px rgba(34,197,94,.2)}
        .cbw-off span{background:#f59e0b;box-shadow:0 0 0 4px rgba(245,158,11,.2)}
    </style>
    <div class="wrap cbw">
        <h1>Callback</h1>

        <?php if (!empty($_GET['cbw_error'])) : ?>
            <div class="notice notice-error"><p><?php echo esc_html(rawurldecode(wp_unslash($_GET['cbw_error']))); ?></p></div>
        <?php endif; ?>
        <?php if (!empty($_GET['cbw_done'])) : ?>
            <div class="notice notice-success"><p><strong>Gotowe!</strong> Widget działa na Twojej stronie. Otwórz stronę w nowej karcie i kliknij słuchawkę, żeby go wypróbować.</p></div>
        <?php endif; ?>
        <?php if (!empty($_GET['cbw_saved'])) : ?>
            <div class="notice notice-success"><p>Zapisano.</p></div>
        <?php endif; ?>

        <?php if ($s['site_key'] === '') : ?>
            <div class="cbw-card">
                <h2>Włącz oddzwanianie na swojej stronie</h2>
                <p class="lead">Klient zostawia numer w widgecie, a my w kilka sekund dzwonimy na Twój telefon i łączymy Cię z nim.</p>
                <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
                    <input type="hidden" name="action" value="cbw_connect">
                    <?php wp_nonce_field('cbw_connect'); ?>
                    <label for="cbw_phone">Na jaki numer mamy dzwonić?</label>
                    <input type="tel" id="cbw_phone" name="phone" value="<?php echo esc_attr($phone); ?>" placeholder="np. 600 100 200" required autofocus>
                    <p class="hint">Twój numer albo numer konsultanta. Klient go nie zobaczy.</p>
                    <label for="cbw_email">E-mail</label>
                    <input type="email" id="cbw_email" name="email" value="<?php echo esc_attr($email); ?>" required>
                    <p class="hint">Na ten adres założymy konto w panelu Callback.</p>
                    <?php if ($need_password) : ?>
                        <label for="cbw_pw">Hasło do panelu Callback</label>
                        <input type="password" id="cbw_pw" name="password" required>
                        <p class="hint">Masz już konto z tym e-mailem. Podaj hasło, a podłączymy do niego tę stronę.</p>
                    <?php endif; ?>
                    <button type="submit" class="button go">Włącz widget</button>
                    <p class="hint" style="margin-top:14px">Plan Start jest darmowy.</p>
                </form>
            </div>
        <?php else : ?>
            <div class="cbw-card">
                <?php if ($s['enabled'] === '1') : ?>
                    <p class="cbw-ok"><span></span>Widget działa na Twojej stronie</p>
                <?php else : ?>
                    <p class="cbw-ok cbw-off"><span></span>Widget jest wyłączony</p>
                <?php endif; ?>
                <p class="lead">Leady, statystyki, godziny pracy, kolory i teksty widgetu zmieniasz w panelu.</p>
                <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>" target="_blank" style="display:inline">
                    <input type="hidden" name="action" value="cbw_panel">
                    <?php wp_nonce_field('cbw_panel'); ?>
                    <button type="submit" class="button go" style="margin-top:0">Otwórz panel →</button>
                </form>
                <a class="button" href="<?php echo esc_url(home_url('/')); ?>" target="_blank" style="margin-left:8px">Zobacz na stronie</a>
            </div>

            <div class="cbw-card">
                <h2 style="font-size:16px">Opcje</h2>
                <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
                    <input type="hidden" name="action" value="cbw_options">
                    <?php wp_nonce_field('cbw_options'); ?>
                    <label><input type="checkbox" name="enabled" value="1" <?php checked($s['enabled'], '1'); ?>> Pokazuj widget na stronie</label>
                    <label for="cbw_ex">Nie pokazuj na podstronach (początek adresu, po jednym w linii)</label>
                    <textarea id="cbw_ex" name="exclude" rows="3" class="large-text" placeholder="/koszyk&#10;/polityka-prywatnosci"><?php echo esc_textarea($s['exclude']); ?></textarea>
                    <?php submit_button('Zapisz', 'secondary'); ?>
                </form>
                <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>" onsubmit="return confirm('Odłączyć stronę od Callback? Widget zniknie ze strony.');">
                    <input type="hidden" name="action" value="cbw_disconnect">
                    <?php wp_nonce_field('cbw_disconnect'); ?>
                    <button type="submit" class="button-link" style="color:#b32d2e">Odłącz stronę</button>
                </form>
            </div>
        <?php endif; ?>
    </div>
    <?php
}
