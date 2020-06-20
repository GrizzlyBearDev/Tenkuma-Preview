/*
* Imports
*/
const fs = require('fs');
const Discord = require('discord.js');
const express = require('express');
const app = express();
const { prefix, token } = require('./config.json');
const {Stitch, RemoteMongoClient, UserPasswordCredential} = require('mongodb-stitch-server-sdk');
const chalk = require('chalk')
const cooldown = require('./cooldown.js')
const experience = require('./experience.js')

//Login Info
const email = '<removed for security>'
const password = '<removed for security>'

/*
* Setting up the DB
*/
const mongoclient = Stitch.initializeDefaultAppClient('<removed for security>');

// Log in to Stitch
const defclient = Stitch.defaultAppClient
const credential = new UserPasswordCredential(email, password)
defclient.auth.loginWithCredential(credential)
.then(authedUser => {
	console.log('-------------------------------------')
    console.log(chalk.green('Tenkuma has succesfully logged in to Stitch.'))
})
.catch(err => console.log('There was a problem logging Tenkuma in. The error is: ', err))
const dbClient = defclient.getServiceClient(RemoteMongoClient.factory, 'mongodb-atlas')

/*
* Setting up the discord client
*/
const client = new Discord.Client({ partials: ['MESSAGE', 'REACTION'] });
client.commands = new Discord.Collection();

/*
* Objects used by the dynamic command loader to keep track of which command belongs to what file and vice versa
*/
let commandToFile = {};
let fileToCommand = {};

/*
* Scanning the directory for the command files
*/
let commandFiles = fs.readdirSync('./commands').filter(file => file.endsWith('.js'));
let fileCount = commandFiles.length;


/*
* Dynamic command loader 
*/
fs.watch('./commands', (event, filename) => {
	if((!filename.endsWith('.js')) || typeof filename == 'undefined') return;
	if(!fs.existsSync(`./commands/${filename}`)) {
		fileCount--;
		if(typeof fileToCommand[filename] != 'undefined'){
			client.commands.delete(fileToCommand[filename]);
			delete commandToFile[fileToCommand[filename]];
			delete fileToCommand[filename];
		}
		return;
	}
	const command = eval(fs.readFileSync(`./commands/${filename}`, 'UTF8'));
	if(typeof command == 'undefined') return;
	if(typeof command.name == 'undefined') return;
	if(typeof command.execute == 'undefined' && typeof command.apiFunc == 'undefined') return;
    if(event == "rename"){
		try{
			commandFiles = fs.readdirSync('./commands').filter(file => file.endsWith('.js'));
			if(commandFiles.length > fileCount){
				fileCount = commandFiles.length;
				fileToCommand[filename] = command.name;
				commandToFile[command.name] = filename;
				client.commands.set(command.name, command);
			}else{
				delete fileToCommand[commandToFile[command.name]];
				fileToCommand[filename] = command.name;
			}
		}catch(error){
			console.log(error)
		}
	}else if(event == "change"){
		try{
			if(typeof commandToFile[command.name] == 'undefined'){
				if(typeof fileToCommand[filename] == 'undefined'){
					fileToCommand[filename] = command.name;
					commandToFile[command.name] = filename;
				}else{
					client.commands.delete(fileToCommand[filename]);
					fileToCommand[filename] = command.name;
				}
			}
			client.commands.set(command.name, command);
		}catch(error){
			console.log(error);
		}
	}
});


/*
* Initial command loader based on the readdir done earlier
*/
for (const file of commandFiles) {
	const command = require(`./commands/${file}`);
	commandToFile[command.name] = file;
	fileToCommand[file] = command.name;
	client.commands.set(command.name, command);
	console.log(chalk.green(command.name), ' loaded. ')
}

/*
* Message handler
*/
client.on('message', async message => {
	const args = message.content.slice(prefix.length).split(' ');
	const command = args.shift().toLowerCase();
	if(message.channel.type !== 'dm'){
		if(!(message.author.id === message.guild.owner.id)){
			client.commands.get('lock').checkLock(message)
		}else if(command == 'unlock'){
			client.commands.get('lock').execute(message, args)
			return
		}
	}
	experience.addXP(message.author.id, dbClient)
	if (!client.commands.has(command)) return;
    try {
		if(cooldown.coolDown(message.author.id)) return
		if(client.commands.get(command).db === true)
			if(cooldown.dbCoolDown(message.author.id))
				return
		if(message.channel.type !== "dm"){
			try{
				const serverConfig = await getDisallowed(message.guild.id);
				const disallowedCommands = serverConfig.disallowedCommands.split(',')
				if(disallowedCommands.includes(command))
					return;
			}catch{}
		}
		if(command == 'help'){
			client.commands.get('help').execute(message, args, client.commands);
			return;
		}
		if(command == 'vote'){
			client.commands.get('vote').execute(message, args, client);
			return;
		}
		if(command == 'profile'){
			client.commands.get('profile').execute(message, args, client, experience)
			return
		}
		if(typeof client.commands.get(command).execute == 'function'){
			client.commands.get(command).execute(message, args);
		}else if(Array.isArray(client.commands.get(command).execute) && message.channel.type !== "dm"){
			getTierFromMessage(message)
			.then( result => {
				client.commands.get(command).execute[result.tier](message, args);
			}).catch(()=>{
				client.commands.get(command).execute[0](message, args);
			})
		}
    } catch (error) {
		console.error(error);
		message.reply('there was an error trying to execute that command!');
	}
});


/*
* Tier related functions
*/
function getDisallowed(serverId){
	return dbClient.db('<removed in preview>').collection('<removed in preview>').findOne({server_id: serverId})
}
function getTierFromMessage(message){
	return dbClient.db('<removed in preview>').collection('<removed in preview>').findOne({server_id: message.guild.id});
}

function getTierFromToken(token){
	//TODO: Implement a tier system
	return 0;
}

function getServerId(token){
	//TODO: Get & return the server ID from the database based on the token
	return 0;
}

//Login to discord
client.login(token);

/*
* The API server
*/
app.get('/:token/:command', (req, res)=>{
	const command = req.params.command.toLowerCase();
	if (!client.commands.has(command)){
		res.json({success: false, message: 'Command not found!'});
		return;
	}
    try {
		let response;
		if(typeof client.commands.get(command).apiFunc == 'function'){
			response = client.commands.get(command).apiFunc(getServerId(token), req.query.args);
		}else if(Array.isArray(client.commands.get(command).apiFunc)){
			const tier = getTierFromToken(req.params.token);
			if(tier == -1) return;
			response = client.commands.get(command).apiFunc[tier](getServerId(token), req.query.args);
		}else{
			res.json({success: false, message: 'Command not found!'});
			return;
		}
		res.json(response);
    } catch (error) {
		console.error(error);
		res.json({success: false, message: 'Unexpected error, please try again.'});
	}
});

//Start the API server
app.listen('<removed in preview>');