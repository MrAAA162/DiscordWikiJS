const { Client, GatewayIntentBits, PermissionFlagsBits, SlashCommandBuilder, Routes, REST } = require('discord.js');
const axios = require('axios');
const express = require('express');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const ALLOWED_GUILDS = process.env.ALLOWED_GUILDS
    ? process.env.ALLOWED_GUILDS.split(',').map(id => id.trim())
    : [];

async function fetchWikiPages() {
    try {
        const response = await axios.post(process.env.WIKI_GRAPHQL_URL, {
            query: `
        query {
          pages {
            list {
              id
              title
              path
              tags
              isPrivate
            }
          }
        }
      `
        });
        return response.data.data.pages.list
            .filter(page => !page.isPrivate)
            .map(page => ({
                title: page.title,
                path: page.path,
                lowercaseTitle: page.title.toLowerCase(),
                tags: page.tags.map(tag => tag.toLowerCase())
            }));
    } catch (error) {
        console.error('Error fetching wiki pages:', error);
        return [];
    }
}

async function initializeBot() {
    app.get('/status', (req, res) => {
        res.status(200).send('Bot is running!');
    });

    app.listen(PORT, () => {
        console.log(`Express server running on port ${PORT}`);
    });

    const wikiPages = await fetchWikiPages();
    console.log(`Loaded ${wikiPages.length} wiki pages`);

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages
        ]
    });

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

    const wikiCommand = new SlashCommandBuilder()
        .setName('wiki')
        .setDescription('Search Mix It Up Wiki')
        .addStringOption(option =>
            option.setName('query')
                .setDescription('Search term for wiki')
                .setRequired(true)
                .setAutocomplete(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages);

    async function deployCommands(guildId) {
        try {
            await rest.put(
                Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId),
                { body: [wikiCommand.toJSON()] }
            );
            console.log(`Commands deployed for ${guildId}`);
        } catch (error) {
            console.error(`Error deploying commands for ${guildId}:`, error);
        }
    }

    client.on('guildCreate', async (guild) => {
        console.log(`Attempting to join: ${guild.name} (${guild.id})`);

        if (!ALLOWED_GUILDS.includes(guild.id)) {
            console.log(`${guild.name} (${guild.id}) is not on the allowlist. Leaving...`);
            try {
                await guild.leave();
                console.log(`Left non-allowlisted guild: ${guild.name} (${guild.id})`);
            } catch (error) {
                console.error(`Failed to leave ${guild.name} (${guild.id}):`, error);
            }
            return;
        }

        await deployCommands(guild.id);
    });

    client.on('interactionCreate', async interaction => {
        if (!interaction.guild || !ALLOWED_GUILDS.includes(interaction.guild.id)) {
            if (interaction.isChatInputCommand() || interaction.isAutocomplete()) {
                try {
                    await interaction.reply({
                        content: 'This bot is not authorized to operate in this server.',
                        ephemeral: true
                    });
                } catch (error) {
                    console.log(`Could not send unauthorized message in ${interaction.guild.name}`);
                }
            }
            return;
        }

        if (interaction.isAutocomplete()) {
            const focusedValue = interaction.options.getFocused();

            if (focusedValue.length < 3) {
                await interaction.respond([
                    {
                        name: 'Start typing to search wiki pages (min 3 characters)',
                        value: 'start_typing'
                    }
                ]);
                return;
            }

            const filtered = wikiPages
                .filter(page =>
                    page.lowercaseTitle.includes(focusedValue.toLowerCase()) ||
                    page.tags.some(tag => tag.toLowerCase().includes(focusedValue.toLowerCase()))
                )
                .slice(0, 25)
                .map(page => ({
                    name: page.title,
                    value: page.path
                }));

            if (filtered.length === 0) {
                await interaction.respond([
                    {
                        name: 'No wiki pages found. Try a different search.',
                        value: 'no_results'
                    }
                ]);
                return;
            }

            await interaction.respond(filtered);
        }

        if (interaction.isChatInputCommand()) {
            if (interaction.commandName === 'wiki') {
                const selectedPage = interaction.options.getString('query');

                if (selectedPage === 'start_typing' || selectedPage === 'no_results') {
                    await interaction.reply({
                        content: 'Please select a valid wiki page.',
                        ephemeral: true
                    });
                    return;
                }

                const pageInfo = wikiPages.find(page => page.path === selectedPage);
                const pageTitle = pageInfo ? pageInfo.title : 'Unknown Page';
                const pageUrl = `${process.env.WIKI_BASE_URL}/${selectedPage}`;

                await interaction.reply({
                    content: `**${pageTitle}**: ${pageUrl}`,
                    ephemeral: false
                });
            }
        }
    });

    client.once('ready', async () => {
        console.log(`Logged in as ${client.user.tag}!`);

        const guilds = client.guilds.cache;
        for (const [guildId, guild] of guilds) {
            if (ALLOWED_GUILDS.includes(guildId)) {
                await deployCommands(guildId);
            } else {
                console.log(`Guild ${guild.name} (${guildId}) is not on the allowlist. Disabling...`);
                try {
                    await guild.leave();
                } catch (error) {
                    console.error(`Failed to disable non-allowlisted guild ${guild.name} (${guildId}):`, error);
                }
            }
        }
    });

    client.login(process.env.DISCORD_BOT_TOKEN);
}

initializeBot().catch(console.error);