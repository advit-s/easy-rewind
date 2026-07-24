const nodemailer = require('nodemailer');

describe('Nodemailer compatibility', () => {
  test('createTransport exposes the sendMail shape without network delivery', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });

    expect(typeof transport.sendMail).toBe('function');
    const result = await transport.sendMail({
      from: 'sender@example.invalid',
      to: 'recipient@example.invalid',
      subject: 'Compatibility check',
      text: 'This message is serialized locally and is never sent.',
    });

    expect(result.message).toBeDefined();
    transport.close();
  });
});
