
const {
  SlashCommandBuilder,
  MessageFlags,
  PermissionFlagsBits,
} = require('discord.js');

const ALLOWED_ROLES = [
  '1555279470758199377', // Server Administrator
  '1555279475585974395', // Management / Senior Moderator
  '1555283780447641620', // Moderator
];

const OWNER_ID = '1444276604938489886';

function canUse(member, userId) {
  if (userId === OWNER_ID) return true;

  return (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    ALLOWED_ROLES.some((roleId) => member.roles.cache.has(roleId))
  );
}

function getMessageText(text) {
  return text.trim().slice(0, 2000);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('say')
    .setDescription('Make the bot send a message')
    .addStringOption((option) =>
      option
        .setName('message')
        .setDescription('The message the bot should send')
        .setRequired(true)
        .setMaxLength(2000)
    )
    .setDMPermission(false),

  async execute(input, args = []) {
    // Slash command: /say message: Hello everyone
    if (input.isChatInputCommand?.()) {
      const interaction = input;

      if (!canUse(interaction.member, interaction.user.id)) {
        return interaction.reply({
          content: 'You do not have permission to use this command.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const text = getMessageText( 
        interaction.options.getString('message', true)
      );

      await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
      });

      await interaction.channel.send({
        content: text,
        allowedMentions: { parse: [] },
      });

      return interaction.editReply('Message sent.');
    }

    // Prefix command: -say Hello everyone
    const message = input;
    const text = getMessageText(args.join(' '));

    if (!canUse(message.member, message.author.id)) {
      return message.reply('You do not have permission to use this command.');
    }

    if (!text) {
      return message.reply('Usage: `-say <message>`');
    }

    await message.channel.send({
      content: text,
      allowedMentions: { parse: [] },
    });
  },
};
