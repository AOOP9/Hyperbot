const lichessBotName = process.env.BOT_NAME || "blazikenbot2000"
const engineThreads = process.env.ENGINE_THREADS || "1"
const engineMoveOverhead = process.env.ENGINE_MOVE_OVERHEAD || "100"
const generalTimeout = parseInt(process.env.GENERAL_TIMEOUT || "5")
const queryPlayingInterval = parseInt(process.env.QUERY_PLAYING_INTERVAL || "60")
const challengeInterval = parseInt(process.env.CHALLENGE_INTERVAL || "30")
const challengeTimeout = parseInt(process.env.CHALLENGE_TIMEOUT || "60")
const allowPonder = process.env.ALLOW_PONDER == "true"
const logApi = process.env.LOG_API == "true"
const useBook = process.env.USE_BOOK == "true"

const path = require('path')
const express = require('express')
const app = express()
const port = process.env.PORT || 3000

const fetch = require('node-fetch')

const { streamNdjson } = require('@easychessanimations/fetchutils')
const lichessUtils = require("@easychessanimations/lichessutils")

const UciEngine = require('@easychessanimations/uci')

const engine = new UciEngine(path.join(__dirname, 'stockfish12'))

const { Chess } = require('chess.js')

let playingGameId = null

const { sseMiddleware, setupStream, ssesend, TICK_INTERVAL } = require('@easychessanimations/sse')

app.use(sseMiddleware)

setupStream(app)

function logPage(content){
    console.log(content)

    ssesend({
        kind: "logPage",
        content: content
    })
}

const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL
const KEEP_ALIVE_INTERVAL = parseInt(process.env.KEEP_ALIVE_INTERVAL || "5")

const possibleOpeningMoves = ["e2e4", "d2d4", "c2c4", "g1f3", "e2e3"]

const possibleOpeningResponses = {
    "e2e4": ["e7e6", "e7e5", "c7c5", "c7c6", "g8f6", "g7g6", "b7b6", "d7d5"],
    "d2d4": ["e7e6", "e7e5", "c7c5", "c7c6", "g8f6", "d7d5"],
    "c2c4": ["e7e6", "e7e5", "c7c5", "c7c6", "g8f6"],
    "g1f3": ["d7d5", "d7d6", "c7c5", "g8f6"],
    "e2e3": ["e7e5", "d7d6", "c7c5", "g8f6"]
}

function requestBook(fen){
    return new Promise(resolve=>{
        let reqUrl = `https://explorer.lichess.ovh/lichess?fen=${fen}&ratings[]=2200&ratings[]=2500&speeds[]=blitz&speeds[]=rapid&moves=10&variant=standard`
        console.log(reqUrl)
        fetch(reqUrl).then(response=>response.text().then(content=>{
            try{
                let blob = JSON.parse(content)

                resolve(blob)
            }catch(err){resolve(null)}
        }))
    })    
}

async function makeMove(gameId, state, moves){
    if(gameId != playingGameId){
        logPage(`refused to make move for invalid game ${gameId} ( playing : ${playingGameId} )`)
        return
    }

    logPage(`engine thinking with ${engineThreads} thread(s) and overhead ${engineMoveOverhead} on game ${gameId}, fen ${state.fen}, moves ${moves}`)

    engine.logProcessLine = false

    let enginePromise = engine
        .position('startpos', moves)
        .gothen({ wtime: state.wtime, winc: state.winc, btime: state.btime, binc: state.binc, ponderAfter: allowPonder })

    if(moves.length == 0){                    
        let randomOpeningMove = possibleOpeningMoves[Math.floor(Math.random() * possibleOpeningMoves.length)]
        enginePromise = Promise.resolve({
            bestmove: randomOpeningMove,
            random: true
        })
    }

    if(moves.length == 1){                    
        let responses = possibleOpeningResponses[moves[0]]

        if(responses){
            let randomOpeningResponse = responses[Math.floor(Math.random() * responses.length)]
            enginePromise = Promise.resolve({
                bestmove: randomOpeningResponse,
                random: true
            })
        }                    
    }

    if(useBook){
        let blob = await requestBook(state.fen)

        console.log(blob)
    }
    
    enginePromise.then(result => {
        let bestmove = result.bestmove
        let ponder = result.ponder

        let score = {unit: "none", value: "none"}

        try{
            scoreTemp = result.depthInfos[result.depthInfos.length - 1].score
            if(scoreTemp) score = scoreTemp
        }catch(err){console.log(err)}

        let logMsg = `bestmove: ${bestmove}, ponder: ${ponder || "none"}, source: ${result.random ? "random":"engine"}, score unit: ${score.unit}, score value: ${score.value}`

        logPage(logMsg)

        lichessUtils.postApi({
            url: lichessUtils.makeBotMoveUrl(gameId, bestmove), log: logApi, token: process.env.TOKEN,
            callback: content => {
                if(logApi) logPage(`move ack: ${content}`)
                if(content.match(/error/)){
                    logPage(`retry move for ${gameId} ${moves}`)

                    makeMove(gameId, state, moves)
                }
            }
        })
    })
}

app.use('/', express.static(__dirname))

app.get('/', (req, res) => {
    res.send(`
    <!doctype html>
    <html>
        <head>
            <title>Hyper Bot</title>
            <style>
            p {
                max-width: 700px;
                background-color: #eee;
                padding: 6px;
                padding-left: 12px;
                border-style: solid;
                border-width: 1px;
                border-color: #aaa;
                border-radius: 15px;
            }
            body {
                padding-left: 20px;
            }
            </style>
            <script src="https://unpkg.com/@easychessanimations/sse@1.0.6/lib/sseclient.js"></script>
        </head>
        <body>
            <h1>Robot-Patzer Online Bot!</h1>            
            <p><a href="https://lichess.org/@/${lichessBotName}" rel="noopener noreferrer" target="_blank">
            <script>            
            function processSource(blob){
                if(blob.kind == "tick"){                    
                    if(isFirstSourceTick) console.log("stream started ticking")
                }

                if(blob.kind == "logPage"){
                    let content = blob.content

                    console.log(content)

                    if(content.match(/^bestmove/)) document.getElementById("logBestmove").innerHTML = content
                }
            }

            setupSource(processSource, ${TICK_INTERVAL})    
            </script>
        </body>
    </html>
    `)  
})

function playGame(gameId){
    logPage(`playing game: ${gameId}`)

    engine
    .setoption("Threads", engineThreads)
    .setoption("Move Overhead", engineMoveOverhead)

    setTimeout(_=>lichessUtils.gameChat(gameId, "all", `https://robot-patzer.herokuapp.com/`), 2000)
    //setTimeout(_=>lichessUtils.gameChat(gameId, "all", `Good luck!`), 4000)

    playingGameId = gameId

    let botWhite

    streamNdjson({url: lichessUtils.streamBotGameUrl(gameId), token: process.env.TOKEN, timeout: generalTimeout, log: logApi, timeoutCallback: _=>{
        logPage(`game ${gameId} timed out ( playing : ${playingGameId} )`)
        
        if(playingGameId == gameId) playGame(gameId)
    }, callback: blob => {        
        if(blob.type == "gameFull"){                
            botWhite = blob.white.name == lichessBotName
        }

        if(blob.type != "chatLine"){                
            let moves = []

            let state = blob.type == "gameFull" ? blob.state : blob

            if(state.moves){
                moves = state.moves.split(" ")

                const chess = new Chess()
                for(let move of moves) chess.move(move, {sloppy:true})
                state.fen = chess.fen()
            }

            let whiteMoves = (moves.length % 2) == 0
            let botTurn = (whiteMoves && botWhite) || ((!whiteMoves) && (!botWhite))

            if(logApi) logPage(`bot turn: ${botTurn}`)

            if(botTurn){
                try{
                    makeMove(gameId, state, moves)
                }catch(err){console.log(err)}
            }
        }     
    }})
}

function streamEvents(){
    streamNdjson({url: lichessUtils.streamEventsUrl, token: process.env.TOKEN, timeout: generalTimeout, log: logApi, timeoutCallback: _=>{
        logPage(`event stream timed out`)

        streamEvents()
    }, callback: blob => {        
        if(blob.type == "challenge"){
            let challenge = blob.challenge
            let challengeId = challenge.id

            if(playingGameId){
                logPage(`can't accept challenge ${challengeId}, already playing`)
            }else if(challenge.speed == "correspondence"){
                logPage(`can't accept challenge ${challengeId}, no correspondence`)
            }else if(challenge.speed == "classical"){
                logPage(`can't accept challenge ${challengeId}, no classical`)
            }else if(challenge.variant.key != "standard"){
                logPage(`can't accept challenge ${challengeId}, non standard`)
            }else{
                lichessUtils.postApi({
                    url: lichessUtils.acceptChallengeUrl(challengeId), log: logApi, token: process.env.TOKEN,
                    callback: content => logPage(`accept response: ${content}`)
                })
            }
        }

        if(blob.type == "gameStart"){                
            let gameId = blob.game.id

            if(playingGameId){
                logPage(`can't start new game ${gameId}, already playing`)
            }else{
                playGame(gameId)
            }                    
        }

        if(blob.type == "gameFinish"){                
            let gameId = blob.game.id

            if(gameId == playingGameId){
                playingGameId = null

                logPage(`game ${gameId} terminated ( playing : ${playingGameId} )`)

                engine.stop()

                setTimeout(_=>lichessUtils.gameChat(gameId, "all", `Good game !`), 2000)
            }
        }         
    }})
}

function challengeBot(bot){
    return new Promise(resolve=>{
        lichessUtils.postApi({
            url: lichessUtils.challengeUrl(bot), log: logApi, token: process.env.TOKEN,
            body: `rated=${Math.random()>0.5?"true":"false"}&clock.limit=${60 * (Math.floor(Math.random() * 5) + 1)}&clock.increment=0`,
            contentType: "application/x-www-form-urlencoded",
            callback: content => {
                logPage(`challenge response: ${content}`)
                resolve(content)
            }
        })
    })    
}

app.get('/chr', (req, res) => {
    challengeRandomBot().then(result=>res.send(result))
})

app.listen(port, _ => {
    console.log(`Hyperbot listening on port ${port} !`)

    if(KEEP_ALIVE_URL){
        console.log(`keep alive interval: ${KEEP_ALIVE_INTERVAL} , url: ${KEEP_ALIVE_URL}`)

        setInterval(_=>{
            let hours = new Date().getHours()
            if((hours > 5)&&(hours<23)){
                console.log(`hours ok: ${hours}, keep alive`)
                fetch(KEEP_ALIVE_URL)
            }        
        }, KEEP_ALIVE_INTERVAL * 60 * 1000)
    }

    streamEvents()

    setInterval(_=>{
        fetch(`https://lichess.org/api/user/${lichessBotName}`).then(response=>response.text().then(content=>{
            try{
                let blob = JSON.parse(content)

                let playing = blob.count.playing

                if(logApi) logPage(`playing: ${playing}`)

                if(!playing){
                    if(playingGameId){
                        logPage(`inconsistent playing information, resetting playing game id`)

                        playingGameId = null
                    }
                }
            }catch(err){console.log(err)}
        }))
    }, queryPlayingInterval * 1000)

    let lastPlayedAt = 0
    setInterval(_=>{
        if(playingGameId){
            lastPlayedAt = new Date().getTime()
        }else{
            if((new Date().getTime() - lastPlayedAt) > challengeTimeout * 60 * 1000){
                console.log(`idle timed out`)
                challengeRandomBot()
            }
        }
    }, challengeInterval * 60 * 1000)
})
