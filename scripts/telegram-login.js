// One-time LOCAL login helper for the Telegram lead-monitoring account.
// Run this yourself, on your own computer — never in CI.
//
// It logs into a Telegram account via the official MTProto client library
// (the same protocol Telegram Desktop/Mobile use) and prints a "session
// string" you paste into a GitHub secret (TELEGRAM_SESSION). After that,
// find-leads-telegram.js can reconnect as that account without you logging
// in again — no phone/SMS code needed on every run.
//
// Nothing here is sent anywhere except Telegram's own servers.
//
// Usage:
//   node scripts/telegram-login.js
//
// You'll be asked for:
//   - API ID / API Hash  (get these once, free, at https://my.telegram.org
//     -> API development tools — tied to the Telegram account you log in
//     with, so use the DEDICATED account you made for this, not your
//     personal one)
//   - Phone number (with country code, e.g. +420...)
//   - The login code Telegram sends you
//   - Your 2FA cloud password, if you have one set

const readline = require('readline');
const { TelegramClient } = require('teleproto');
const { StringSession } = require('teleproto/sessions');

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (!hidden) {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
      return;
    }
    // crude masked input for the 2FA password
    const stdin = process.stdin;
    process.stdout.write(question);
    let value = '';
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (char) => {
      if (char === '\n' || char === '\r' || char === '') {
        stdin.setRawMode?.(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        rl.close();
        resolve(value.trim());
      } else if (char === '') {
        process.exit(1);
      } else if (char === '') {
        value = value.slice(0, -1);
      } else {
        value += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  console.log('=== Telegram login (one-time, local only) ===\n');
  console.log('Возьми API ID / API Hash на https://my.telegram.org (API development tools),');
  console.log('залогинившись ТЕМ САМЫМ отдельным аккаунтом, который заведёшь под этот бот.\n');

  const apiId = Number((await ask('API ID: ')).trim());
  const apiHash = (await ask('API Hash: ')).trim();
  const phone = (await ask('Номер телефона (с кодом страны, напр. +420...): ')).trim();

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => phone,
    password: async () => ask('Облачный пароль (2FA), если есть, иначе Enter: ', { hidden: true }),
    phoneCode: async () => ask('Код из Telegram (пришёл в приложение/SMS): '),
    onError: (err) => console.error('Login error:', err),
  });

  const sessionString = client.session.save();

  console.log('\n=== Готово! ===');
  console.log('Залогинен как:', (await client.getMe()).username || (await client.getMe()).firstName);
  console.log('\nСохрани эти три значения как секреты репозитория (Settings -> Secrets and variables -> Actions):');
  console.log('  TELEGRAM_API_ID     =', apiId);
  console.log('  TELEGRAM_API_HASH   =', apiHash);
  console.log('  TELEGRAM_SESSION    =', sessionString);
  console.log('\nTELEGRAM_SESSION — по сути ключ от аккаунта. Никому не показывай, кроме как в Secrets на GitHub.');

  await client.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error('telegram-login failed:', e);
  process.exit(1);
});
