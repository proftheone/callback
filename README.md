# Callback: widget oddzwaniania na stronę (alternatywa dla Callback24)

**Adresy:** `/` landing page · `/app/` panel klienta (rejestracja) · `/admin/` panel właściciela · `/downloads/callback-widget.zip` wtyczka WordPress.
Na WordPressie instalacja to: wtyczka → numer telefonu → „Włącz widget” (konto zakłada się automatycznie, logowanie do panelu jednym kliknięciem z kokpitu WP).

Odwiedzający zostawia numer w widgecie, a system w kilka sekund dzwoni do konsultanta i po odebraniu łączy go z klientem.
Poza godzinami pracy klient wybiera termin, a rozmowa jest wykonywana automatycznie o tej porze.

## Co jest w MVP
- **Widget** (`public/widget.js`): pływająca słuchawka, panel z numerem, odliczanie 30 s, terminy poza godzinami pracy,
  exit intent, automatyczne otwarcie po X sekundach, motyw ciemny/jasny, kolor, pozycja, własne teksty. Shadow DOM, więc nie koliduje ze stylami strony.
- **Telefonia** (`src/telephony.js`): Twilio (najpierw konsultant, potem klient), ponawianie gdy konsultant nie odbierze,
  opcjonalne nagrywanie, weryfikacja podpisu webhooków. Bez kluczy Twilio aplikacja nie dzwoni, a zgłoszenia mają status **Nowe**.
- **Panel admina** (`/admin/`): leady z filtrami i wyszukiwarką, tagi i notatki, ponowne połączenie, eksport CSV,
  statystyki (skuteczność, czas do połączenia, długość rozmów, źródła UTM, wyzwalacze), wiele stron (np. otoneso.pl, eprpilot.com).
- **Integracje**: webhook JSON na każde zdarzenie (`lead.created`, `call.finished`, `call.missed`) do CRM / Zapier / Make.
- **Ochrona**: limit 3 próśb / IP / 10 min, honeypot na boty, lista dozwolonych domen.

## Uruchomienie
Wymaga Node.js 22.13+ (bez zewnętrznych zależności, baza SQLite wbudowana w Node).

```bash
cp .env.example .env    # ustaw ADMIN_PASSWORD (i ewentualnie Twilio)
npm start               # http://localhost:3000/admin/
```

Kod do wklejenia na stronę znajdziesz w panelu w zakładce „Strony i ustawienia”:
```html
<script src="https://callback.twojadomena.pl/widget.js" data-site="KLUCZ" async></script>
```

## Wdrożenie
- `docker compose up -d` uruchamia aplikację + Caddy (automatyczny HTTPS). Domenę ustawiasz w `Caddyfile`.
- Instalacja: **[INSTALACJA-WORDPRESS.md](INSTALACJA-WORDPRESS.md)**.
- Wtyczka WordPress: `wordpress-plugin/callback-widget.zip`.

## Podłączenie Twilio
1. Konto Twilio + polski numer (wymaga Regulatory Bundle) lub numer z innego kraju.
2. W `.env`: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_NUMBER`, `PUBLIC_URL` (publiczny adres HTTPS serwera).
3. W panelu ustaw „Telefon konsultanta” dla każdej strony.

## Struktura
```
src/server.js      API, webhooki Twilio, harmonogram, serwowanie plików
src/db.js          SQLite: strony, leady, zdarzenia, statystyki
src/telephony.js   Twilio + tryb DEMO
src/hours.js       godziny pracy i wolne terminy (strefa czasowa strony)
public/widget.js   widget osadzany na stronach
public/admin/      panel administracyjny
public/demo.html   podgląd widgetu: /demo?site=KLUCZ
```
