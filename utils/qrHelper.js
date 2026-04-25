const QRCode = require('qrcode');
const Jimp = require('jimp');
const jsQR = require('jsqr');
const { Readable } = require('stream');

/**
 * Read a QR code from an image buffer and return the decoded text.
 * Returns null if no QR code is found.
 */
async function readQR(imageBuffer) {
  try {
    const image = await Jimp.read(Buffer.from(imageBuffer));

    // Ensure image is in RGBA format (required by jsQR)
    image.rgba(true);

    const { data, width, height } = image.bitmap;

    // In newer Jimp versions, data is a Buffer — must extract the underlying
    // ArrayBuffer correctly instead of passing the Buffer directly.
    const uint8Clamped = data instanceof Uint8ClampedArray
      ? data
      : new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);

    const result = jsQR(uint8Clamped, width, height);
    return result ? result.data : null;
  } catch (err) {
    console.error('readQR internal error:', err.message);
    return null;
  }
}

/**
 * Generate a QR code PNG buffer for the given text
 */
async function generateQR(text) {
  return QRCode.toBuffer(text, {
    type: 'png',
    width: 300,
    margin: 2,
    color: { dark: '#000000', light: '#ffffff' }
  });
}

/**
 * Send a QR code image to a Telegram chat for a card ID
 */
async function sendQR(bot, chatId, cardId) {
  const buffer = await generateQR(cardId);
  const stream = Readable.from(buffer);
  stream.path = `${cardId}.png`;
  await bot.sendPhoto(chatId, stream, {
    caption: `📲 QR Code للبطاقة: \`${cardId}\``,
    parse_mode: 'Markdown'
  });
}

module.exports = { sendQR, readQR };