let { SlashCommandBuilder } = require("@discordjs/builders");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("info")
        .setDescription("Get info about a user or a server!")
        .addSubcommand(subcommand => subcommand
            .setName('user')
            .setDescription('Info about a user')
            .addUserOption(option => option.setName('user').setDescription('The user you want info about')))
        .addSubcommand(subcommand => subcommand
            .setName('server')
            .setDescription('Info about the server')),

    async execute(interaction) {
        if (interaction.options.getSubcommand() === 'user') {
            let user = interaction.options.getUser('user');

            if (user) {
                await interaction.reply(`Username: ${user.username}\nID: ${user.id}`);
            } else {
                await interaction.reply({ content: `Your username: ${interaction.user.username}\nYour ID: ${interaction.user.id}`, ephemeral: true });
            }
        } else if (interaction.options.getSubcommand() === 'server') {
            await interaction.reply(`Server name: ${interaction.guild.name}\nTotal members: ${interaction.guild.memberCount}`);
        }
    },
};

