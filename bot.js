require(`dotenv`).config();
let fs = require(`node:fs`);
let { Routes } = require(`discord-api-types/v10`);
let { REST } = require(`@discordjs/rest`);
let { Collection } = require(`discord.js`);
let Discord = require(`discord.js`);


let client = new Discord.Client({
    partials: [`CHANNEL`],
    intents: [`DIRECT_MESSAGES`, `GUILDS`, `GUILD_MESSAGES`, `GUILD_MEMBERS`],
});

client.botConfig = process.env;

client.commands = new Collection();
let commands = [];
let commandFiles = fs.readdirSync(`./commands`).filter((file) => file.endsWith(`.js`));

for (let file of commandFiles) {
    let command = require(`./commands/${file}`);
    client.commands.set(command.data.name, command);
    commands.push(command.data.toJSON());
}

client.on(`ready`, function (evt) {
    console.log(`Logged in as: ${client.user.username} (${client.user.id})`);
    client.user.setActivity(`Bot is ALIVE!`); // Set the bot's activity status.
});

client.on(`interactionCreate`, async (interaction) => {
    if (!interaction.isCommand()) return;

    let command = client.commands.get(interaction.commandName);
    if (!command) return;
    
    try {
        await command.execute(interaction);
    } catch (error) {
        console.error(error);
        await interaction.reply({ content: `There was an error while executing this command!`, ephemeral: true });
    }
});

let rest = new REST({ version: `10` }).setToken(client.botConfig.BOT_TOKEN);

// Setup slash commands server specific
rest.put(Routes.applicationGuildCommands(client.botConfig.BOT_APP_ID, client.botConfig.SERVER_ID), { body: commands }).then(() => console.log(`Successfully registered application commands.`)).catch(console.error);

// sets slash commands globally
//rest.put(Routes.applicationCommands(client.botConfig.BOT_APP_ID), { body: commands });

client.login(client.botConfig.BOT_TOKEN);