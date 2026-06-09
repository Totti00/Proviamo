# Proviamo - Smart Locker Hub

Applicazione web per la gestione di un deposito bagagli con 25 armadietti, con:

- **Livello utente**: prenotazione, pagamento e apertura armadietto.
- **Livello operativo**: monitoraggio stato armadietti e tracciamento eventi.
- **Terzo livello di coordinamento**: orchestrazione regole, sicurezza e dashboard operativa.

## Requisiti

- Node.js 20+

## Avvio

```bash
npm install
npm start
```

Apri: `http://localhost:3000`

## Credenziali demo (MFA)

- Utente: `mario` / `User#2026!` / OTP `173829`
- Utente 2: `luigi` / `User#2026!` / OTP `223344`
- Admin: `admin` / `Admin#2026!` / OTP `998811`

## Flussi implementati

1. Prenotazione → pagamento → assegnazione/uso armadietto
2. Arrivo utente → verifica credenziali + OTP → apertura con access code
3. Fine utilizzo → rilascio armadietto → generazione ricevuta/notifica

## Sicurezza implementata

- Login con password + OTP (2 fattori demo)
- Session token con scadenza
- Autorizzazione su prenotazioni per proprietario/admin
- Audit log di login, pagamenti, aperture, dinieghi, rilasci
- Protezione base input/JSON, limiti payload, no-store cache

## Test

```bash
npm test
```
