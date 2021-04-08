import "dotenv/config";

import { Logger } from "@dimensional-fun/logger";
import { ShardClient } from "detritus-client";
import { Obsidian, ObsidianTrackResponseTracks, Player } from "obby.js";
import { Embed } from "detritus-client/lib/utils";

import type { RequestTypes } from "detritus-client-rest";
import type { ChannelGuildText, Message } from "detritus-client/lib/structures";

const logger = new Logger("main");
const client = new ShardClient(process.env.DISCORD_TOKEN!);

/* voice/music */
const queues: Record<string, queue> = {};
const obsidian = new Obsidian({
  nodes: [
    {
      password: "",
      port: 3030,
    },
  ],
  plugins: [],
  send: async (_, p) => {
    await client.gateway.send(p.op, p.d);
  },
});

client.subscribe("raw", (data) => {
  if (![ "VOICE_SERVER_UPDATE", "VOICE_STATE_UPDATE" ].includes(data.t)) {
    return;
  }

  const player = obsidian.players.get(data.d.guild_id);
  if (player) {
    player.handleVoice(data);
  }
});

/* listen for ready */
client.subscribe("gatewayReady", () => {
  logger.info(`ready as ${client.user!.username}#${client.user!.discriminator}`);
  obsidian.init(client.userId);
});

/* listen for messages */
client.subscribe("messageCreate", async ({ message }) => {
  /* check if the message content starts with our prefix. */
  if (!message.content.startsWith(process.env.DISCORD_PREFIX!)) {
    return;
  }

  const [ command, ...args ] = message.content.slice(1).split(/ /g);
  switch (command.toLowerCase()) {
    /* ping command */
    case "ping": {
      const ping = await client.rest.client.ping();

      /* respond with latency of the REST client and Gateway */
      return await message.reply(embed(message, `**Pong!** Rest: *${ping.rest}ms*, Heartbeat: *${ping.gateway}ms*`));
    }

    /* join command */
    case "join": {
      if (!message.guildId) {
        return message.reply(embed(message, "this command can only be ran in guilds."));
      }

      /* check if the invoker is in a voice channel */
      const vc = message.member?.voiceChannel;
      if (!vc) {
        return message.reply(embed(message, "join a voice channel"));
      }

      /* check if a player already exists. */
      const existing = obsidian.players.get(message.guildId);
      if (existing) {
        return message.reply(embed(message, "a player for this guild already exists."));
      }

      /* create the player */
      const player = obsidian.create({ guild: message.guildId! });
      if (!player) {
        /* for some odd reason, obby.js decides that the create method can return undefined */
        return message.reply(embed(message, "hmm something weird happened"));
      }

      /* set the queue */
      const queue = queues[message.guildId!] = {
        player,
        tracks: [],
        channel: message.channel!,
      };

      subscribe(queue);

      /* join the vc */
      player?.connect(vc.id);
      return await message.reply(embed(message, `connected to [**${vc.name}**](https://discord.com/channels/${message.guildId}/${vc.id})`));
    }

    /* play command */
    case "play": {
      /* check if this command was ran in a guild */
      if (!message.guildId) {
        return message.reply(embed(message, "this command can only be ran in guilds."));
      }

      /* get queue */
      let queue = queues[message.guildId],
        vc = message.member!.voiceChannel;

      /* check if a exists */
      if (!queue) {
        /* check if the invoker is in a voice channel */
        if (!vc) {
          return message.reply("join a vc");
        }

        /* create a queue */
        queue = queues[message.guildId] = {
          player: obsidian.create({ guild: message.guildId })!,
          tracks: [],
          channel: message.channel!,
        };

        subscribe(queue);
      } else if (!vc || vc.id !== queue.player.channel) {
        return message.reply(embed(message, "join my voice channel"));
      }

      /* make sure to search for tracks if a url wasn't provided */
      let query = args.join(" ");
      if (!/^https?:\/\//.test(query)) {
        query = `ytsearch:${query}`;
      }

      /* search for results */
      const results = await obsidian.search(query);
      switch (results.load_type) {
        case "LOAD_FAILED":
        case "NO_MATCHES":
          return message.reply(embed(message, `Nothing found for: \`${args.join(" ")}\``));

        case "SEARCH_RESULT":
        case "TRACK_LOADED":
          const toAdd = results.tracks[0];
          queue.tracks.push(toAdd);
          await message.reply(embed(message, `👌 Queued [**${toAdd.info.title}**](${toAdd.info.uri})`));

          break;
        case "PLAYLIST_LOADED": {
          queue.tracks.push(...results.tracks);
          await message.reply(embed(message, `👌 Queued \`${results.tracks.length}\` tracks from playlist: **${results.playlist_info!.name}*`));

          break;
        }
      }

      if (!queue.player.track) {
        const toPlay = queue.tracks.shift();
        if (!toPlay) {
          return;
        }

        queue.player?.play(toPlay.track);
      }

      if (!queue.player.channel) {
        queue.player.connect(vc.id);
      }

      queues[message.guildId] = queue;
      break;
    }
  }
});

client.run();

function embed(message: Message, content: Embed | string): RequestTypes.CreateMessage {
  const embed = typeof content === "string"
    ? new Embed().setDescription(content)
    : content;

  embed.setColor(0xb963a5);

  return {
    messageReference: {
      messageId: message.id,
      channelId: message.channelId,
    },
    embed,
  };
}

function subscribe(queue: queue) {
  queue.player.on("start", async (track) => {
    const info = await obsidian.decode(track, queue.player.socket);

    queue.playing = {
      track,
      info,
    };

    await queue.channel.createMessage({
      embed: new Embed()
        .setDescription(`🎶 Playing [**${info.title}**](${info.uri})`)
        .setColor(0xb963a5),
    });
  });

  queue.player.on("end", () => {
    const next = queue.tracks.shift();
    if (!next) {
      queue.player.disconnect();
      obsidian.players.delete(queue.player.guild);
      return delete queues[queue.player.guild];
    }

    queue.player.play(next.track);
  });
}

interface queue {
  player: Player;
  channel: ChannelGuildText;
  tracks: ObsidianTrackResponseTracks[];
  playing?: ObsidianTrackResponseTracks;
}
