# Instalacja Callback w WordPressie

Serwer Callback działa pod adresem **https://callback.viaregia.online**.

## Instalacja (otoneso.pl, eprpilot.com, każda strona klienta)

Nie trzeba kopiować kodu ani kluczy.

1. Pobierz wtyczkę ze strony https://callback.viaregia.online (przycisk **Pobierz wtyczkę WordPress**) albo bezpośrednio: https://callback.viaregia.online/downloads/callback-widget.zip
2. W WordPressie: **Wtyczki → Dodaj nową → Wyślij wtyczkę na serwer** → wybierz `callback-widget.zip` → **Zainstaluj** → **Włącz**.
3. W menu po lewej kliknij **Callback** (ikona słuchawki).
4. Wpisz **numer telefonu**, na który mamy dzwonić (e-mail jest podpowiedziany) i kliknij **Włącz widget**.

Gotowe. Widget pojawia się na stronie od razu, a konto w panelu zakłada się samo.
Przycisk **Otwórz panel** we wtyczce loguje do panelu bez hasła (leady, statystyki, godziny pracy, kolory, teksty).

> Jeśli widget nie pojawia się po włączeniu, wyczyść cache (LiteSpeed, WP Rocket, Cloudflare).

## Aktualizacja wtyczki

Pobierz nowy plik zip i wgraj go tak jak przy instalacji. WordPress zapyta **„Zastąpić bieżącą wersję wgraną?”** → kliknij **Zastąp**. Ustawienia i połączenie z kontem zostają.

## Adresy

- https://callback.viaregia.online – landing page produktu
- https://callback.viaregia.online/app/ – panel klienta (rejestracja i logowanie)
- https://callback.viaregia.online/admin/ – panel właściciela (tylko hasło `ADMIN_PASSWORD` z Render → Environment)

## Serwer (dla właściciela platformy)

- Hosting: Render, usługa `callback` (Blueprint z repozytorium `proftheone/callback`, plan Starter z dyskiem `/data`). Każdy push do gałęzi `main` wdraża się sam.
- DNS: w strefie `viaregia.online` (AttHost) rekord `CNAME callback → callback-6dnc.onrender.com.`
- Zmienne w Render → Environment: `ADMIN_PASSWORD`, `PUBLIC_URL=https://callback.viaregia.online`, `CONTACT_EMAIL`.
- Powiadomienia e-mail o nowym leadzie: w Render → Environment dodaj `SMTP_HOST`, `SMTP_PORT` (465), `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` (dane skrzynki, np. info@otoneso.pl) oraz `LEAD_NOTIFY_EMAIL=info@otoneso.pl`. Klient może też wpisać własne adresy w panelu: Strony i ustawienia → „E-mail o nowym leadzie”.
- Prawdziwe połączenia: dodaj `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_NUMBER` (polski numer wymaga Regulatory Bundle z danymi firmy, w *Voice → Geo permissions* włączona Polska). Bez nich aplikacja działa w trybie demo: zbiera zgłoszenia, ale nie dzwoni.

## Bez WordPressa

Klient zakłada konto na https://callback.viaregia.online/app/?register, a w zakładce **Strony i ustawienia** kopiuje jedną linię kodu i wkleja ją przed `</body>`.
