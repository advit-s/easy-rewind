const assert = require('node:assert/strict');
const test = require('node:test');
const nodemailer = require('nodemailer');

test('createTransport exposes the sendMail shape without network delivery', async () => {
  const transport = nodemailer.createTransport({ jsonTransport: true });

  try {
    assert.equal(typeof transport.sendMail, 'function');
    const result = await transport.sendMail({
      from: 'sender@example.invalid',
      to: 'recipient@example.invalid',
      subject: 'Compatibility check',
      text: 'This message is serialized locally and is never sent.',
    });

    assert.notEqual(result.message, undefined);
  } finally {
    transport.close();
  }
});
