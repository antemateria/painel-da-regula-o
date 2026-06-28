const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

// --- IMPORTAÇÃO DO MONGODB ---
const { MongoClient } = require('mongodb');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// ========================================================
// ☁️ CONFIGURAÇÃO DA CHAVE MESTRA DO MONGODB (O COFRE)
// ========================================================
// ATENÇÃO MOISÉS: Substitua "SUA_SENHA_AQUI" pela senha real que você gerou!
const MONGO_URI = "mongodb+srv://admin:Po9pSRB2PerSlJ13@cluster0.y1bvdc1.mongodb.net/?appName=Cluster0";
const mongoClient = new MongoClient(MONGO_URI);
let dbCofre; // Variável que guarda a conexão com a nuvem

// --- MEMÓRIA CENTRAL DO SISTEMA ---
let filaPacientes = []; 
let contadores = { 'RP': 1, 'R': 1, 'CP': 1, 'C': 1, 'AT': 1 };
let turnos = { 'REGULACAO': 'P', 'COMPLEXIDADE': 'P', 'AUTORIZACAO': 'P' };

// === CONTROLE DE FICHAS FÍSICAS ===
const limitesFichas = {
    'R': 160, 'RP': 160, 'C': 48, 'CP': 48, 'AT': 160 
};
const fichasDesativadas = new Set(); 

// === RADAR DE OPERADORES ONLINE ===
const operadoresOnline = {}; 

let ultimosChamados = {
    'Regulação': [ { ficha: '---', nome: 'Nenhum' }, { ficha: '---', nome: 'Nenhum' } ],
    'Complexidade': [ { ficha: '---', nome: 'Nenhum' }, { ficha: '---', nome: 'Nenhum' } ],
    'Autorização': [ { ficha: '---', nome: 'Nenhum' }, { ficha: '---', nome: 'Nenhum' } ]
};

let filaDeEsperaTV = []; 
let tvFalando = false;   
let timerSegurancaTV = null;

const dadosPath = path.join(__dirname, 'dados.json');
const fsPromises = fs.promises;
const DEBUG_LOG = path.join(__dirname, 'public', 'debug-38e5fb.log');

app.get('/backup-dados', (req, res) => {
    res.download(dadosPath, `backup-regulacao-${getDataString()}.json`);
});

function dbgLog(location, message, data, hypothesisId) {
    try {
        fs.appendFileSync(DEBUG_LOG, JSON.stringify({ sessionId: '38e5fb', location, message, data, hypothesisId, timestamp: Date.now(), runId: 'pre-fix' }) + '\n');
    } catch (e) { /* ignore */ }
}

function getDataString() {
    return new Date().toISOString().slice(0, 10);
}

let atendimentosPorOperador = {};
let statusDia = { aberto: true, data: getDataString() };
let historicoAtendimentos = [];
let pendingWrite = null;
let lastWriteContent = null;

function obterEstadoAtual() {
    return { filaPacientes, contadores, turnos, ultimosChamados, statusDia, atendimentosPorOperador };
}

// === MOTOR DE INTELIGÊNCIA MATEMÁTICA ===
function calcularEstatisticasAbsenteismo() {
    const dadosPorDia = {};
    
    historicoAtendimentos.forEach(item => {
        if (!item.data) return;
        if (!dadosPorDia[item.data]) dadosPorDia[item.data] = { total: 0, faltas: 0, setores: {} };
        const setor = item.setor || 'Regulação';
        if (!dadosPorDia[item.data].setores[setor]) dadosPorDia[item.data].setores[setor] = { total: 0, faltas: 0 };
        
        if (item.resultado === 'atendido' || item.resultado === 'falta') {
            dadosPorDia[item.data].total++;
            dadosPorDia[item.data].setores[setor].total++;
        }
        if (item.resultado === 'falta') {
            dadosPorDia[item.data].faltas++;
            dadosPorDia[item.data].setores[setor].faltas++;
        }
    });
    
    const listaDatas = Object.keys(dadosPorDia);
    const processarMetricas = (arrayTaxas) => {
        const n = arrayTaxas.length;
        if (n === 0) return { media: 0, variancia: 0, desvioPadrao: 0 };
        const media = arrayTaxas.reduce((a, b) => a + b, 0) / n;
        if (n <= 1) return { media: Math.round(media), variancia: 0, desvioPadrao: 0 };
        const somaQuadrados = arrayTaxas.reduce((acc, val) => acc + Math.pow(val - media, 2), 0);
        const variancia = somaQuadrados / (n - 1);
        const desvioPadrao = Math.sqrt(variancia);
        return { media: Math.round(media), variancia: Math.round(variancia * 100) / 100, desvioPadrao: Math.round(desvioPadrao * 100) / 100 };
    };
    
    const taxasGerais = listaDatas.map(d => {
        const dia = dadosPorDia[d];
        return dia.total > 0 ? (dia.faltas / dia.total) * 100 : 0;
    });
    
    const estatisticas = { geral: processarMetricas(taxasGerais), setores: {} };
    const setoresDisponiveis = ['Regulação', 'Complexidade', 'Autorização'];
    setoresDisponiveis.forEach(setor => {
        const taxasSetor = [];
        listaDatas.forEach(d => {
            const diaSetor = dadosPorDia[d].setores[setor];
            if (diaSetor && diaSetor.total > 0) taxasSetor.push((diaSetor.faltas / diaSetor.total) * 100);
        });
        estatisticas.setores[setor] = processarMetricas(taxasSetor);
    });
    return estatisticas;
}

// ========================================================
// 💾 NOVO SISTEMA DE GRAVAÇÃO HÍBRIDA (JSON + MONGO)
// ========================================================
function salvarDados() {
    const dadosObj = {
        id_documento: 'backup_principal', // Identificador fixo para o Mongo
        filaPacientes, contadores, turnos, ultimosChamados,
        statusDia, atendimentosPorOperador, historicoAtendimentos
    };
    
    const dataString = JSON.stringify(dadosObj, null, 2);
    lastWriteContent = dataString;

    // 1. Grava no disco local imediatamente (A impressora não sofre atraso)
    if (!pendingWrite) {
        pendingWrite = fsPromises.writeFile(dadosPath, dataString, 'utf8')
            .catch((err) => console.error('❌ Erro local:', err))
            .then(() => {
                pendingWrite = null;
                if (lastWriteContent !== dataString) salvarDados();
            });
    }

    // 2. O Piloto Automático: Envia pro Atlas silenciosamente em segundo plano
    if (dbCofre) {
        dbCofre.collection('estado_regulacao').updateOne(
            { id_documento: 'backup_principal' }, 
            { $set: dadosObj }, 
            { upsert: true }
        ).catch(err => console.error("❌ Falha no envio invisível para a nuvem:", err));
    }

    return pendingWrite;
}

// ========================================================
// 🔄 NOVO SISTEMA DE BOOT (RESTAURAÇÃO AUTOMÁTICA)
// ========================================================
async function carregarDados() {
    try {
        // Tenta conectar no Mongo primeiro
        await mongoClient.connect();
        dbCofre = mongoClient.db('db_regulacao');
        console.log("☁️ Conectado com Sucesso ao Cofre Atlas!");

        // Busca o backup na nuvem
        const dadosNuvem = await dbCofre.collection('estado_regulacao').findOne({ id_documento: 'backup_principal' });
        
        if (dadosNuvem) {
            console.log("✈️ Restaurando dados a partir da nuvem...");
            aplicarDadosNaMemoria(dadosNuvem);
            
            // Força a atualização do JSON local para ficar igual à nuvem
            await fsPromises.writeFile(dadosPath, JSON.stringify(dadosNuvem, null, 2), 'utf8');
            return; // Se deu certo, sai da função
        }
    } catch (err) {
        console.log("⚠️ Nuvem indisponível no momento. Recorrendo ao armazenamento local.");
        console.log("🕵️ DETALHE DO ERRO MONGODB:", err.message); // <--- ADICIONE ESTA LINHA
    }
    // Fallback: Se não tem internet ou o Mongo falhou, lê o JSON local
    try {
        await fsPromises.access(dadosPath, fs.constants.F_OK);
        const raw = await fsPromises.readFile(dadosPath, 'utf8');
        aplicarDadosNaMemoria(JSON.parse(raw));
        console.log('✅ Dados carregados localmente do dados.json');
    } catch (err) {
        console.log("⚠️ Sistema iniciando 100% zerado. Nenhum backup encontrado.");
    }
}

function aplicarDadosNaMemoria(dados) {
    if (dados && Array.isArray(dados.filaPacientes)) filaPacientes = dados.filaPacientes;
    if (dados && typeof dados.contadores === 'object') contadores = dados.contadores;
    if (dados && typeof dados.turnos === 'object') turnos = Object.assign({ 'REGULACAO': 'P', 'COMPLEXIDADE': 'P', 'AUTORIZACAO': 'P' }, dados.turnos);
    if (dados && typeof dados.ultimosChamados === 'object') ultimosChamados = dados.ultimosChamados;
    if (dados && typeof dados.statusDia === 'object') statusDia = dados.statusDia;
    if (dados && typeof dados.atendimentosPorOperador === 'object') atendimentosPorOperador = dados.atendimentosPorOperador;
    if (dados && Array.isArray(dados.historicoAtendimentos)) historicoAtendimentos = dados.historicoAtendimentos;
    reconstruirContagens();
}

function reconstruirContagens() {
    atendimentosPorOperador = {};
    const hoje = getDataString(); 
    historicoAtendimentos.forEach(item => {
        if (item.resultado === 'atendido' && item.atendente && item.data === hoje) {
            atendimentosPorOperador[item.atendente] = (atendimentosPorOperador[item.atendente] || 0) + 1;
        }
    });
}

function calcularMediaPorSetor() {
    const hoje = getDataString();
    const setores = { REGULACAO: [], COMPLEXIDADE: [], AUTORIZACAO: [] };
    historicoAtendimentos.forEach(item => {
        if (item.resultado !== 'atendido' || !item.horaAtendimento) return;
        const dataAtendimento = item.horaAtendimento.slice(0, 10);
        if (dataAtendimento !== hoje) return;
        if (item.setor === 'Regulação') setores.REGULACAO.push(item.tempoEspera);
        if (item.setor === 'Complexidade') setores.COMPLEXIDADE.push(item.tempoEspera);
        if (item.setor === 'Autorização') setores.AUTORIZACAO.push(item.tempoEspera);
    });
    return {
        REGULACAO: setores.REGULACAO.length ? Math.round(setores.REGULACAO.reduce((a,b) => a+b,0) / setores.REGULACAO.length) : 0,
        COMPLEXIDADE: setores.COMPLEXIDADE.length ? Math.round(setores.COMPLEXIDADE.reduce((a,b) => a+b,0) / setores.COMPLEXIDADE.length) : 0,
        AUTORIZACAO: setores.AUTORIZACAO.length ? Math.round(setores.AUTORIZACAO.reduce((a,b) => a+b,0) / setores.AUTORIZACAO.length) : 0,
        totalAtendidosHoje: setores.REGULACAO.length + setores.COMPLEXIDADE.length + setores.AUTORIZACAO.length
    };
}

function emitirEstadoCompleto() {
    io.emit('estado_servidor', obterEstadoAtual());
    io.emit('atualizar_media_setores', calcularMediaPorSetor());
    io.emit('atualizar_estatisticas_absenteismo', calcularEstatisticasAbsenteismo());
}

const mapeamentoSetores = {
    'RP': 'Regulação', 'R': 'Regulação', 'CP': 'Complexidade', 'C': 'Complexidade', 'AT': 'Autorização'
};

function realizarResetGeral() {
    clearTimeout(timerSegurancaTV);
    filaPacientes = []; filaDeEsperaTV = []; tvFalando = false; 
    contadores = { 'RP': 1, 'R': 1, 'CP': 1, 'C': 1, 'AT': 1 };
    turnos = { 'REGULACAO': 'P', 'COMPLEXIDADE': 'P', 'AUTORIZACAO': 'P' };
    ultimosChamados = {
        'Regulação': [ { ficha: '---', nome: 'Nenhum' }, { ficha: '---', nome: 'Nenhum' } ],
        'Complexidade': [ { ficha: '---', nome: 'Nenhum' }, { ficha: '---', nome: 'Nenhum' } ],
        'Autorização': [ { ficha: '---', nome: 'Nenhum' }, { ficha: '---', nome: 'Nenhum' } ]
    };
    statusDia = { aberto: true, data: getDataString() };
    io.emit('atualizar_fila', filaPacientes);
    io.emit('atualizar_painel_setores', ultimosChamados);
    enviarQuantitativosFila();
    io.emit('liberar_botoes_tv_livre');
    io.emit('limpar_tv'); 
    io.emit('sistema_resetado');
    emitirEstadoCompleto();
    salvarDados(); 
    console.log(`⏰ Mudança de turno concluída! Novo dia iniciado: ${statusDia.data}`);
}

function agendarResetMeiaNoite() {
    const agora = new Date();
    const meiaNoite = new Date();
    meiaNoite.setHours(24, 0, 0, 0); 
    const tempoAteMeiaNoite = meiaNoite.getTime() - agora.getTime();
    setTimeout(() => {
        realizarResetGeral();
        setInterval(realizarResetGeral, 24 * 60 * 60 * 1000);
    }, tempoAteMeiaNoite);
}

const URL_DO_SEU_SISTEMA = "https://painel-da-regulacao.onrender.com"; 

setInterval(() => {
    https.get(URL_DO_SEU_SISTEMA, (res) => {
        console.log("🔄 Ping enviado para manter o servidor acordado.");
    }).on('error', (err) => {
        console.log("❌ Erro no ping anti-cochilo:", err.message);
    });
}, 10 * 60 * 1000); 

function enviarQuantitativosFila() {
    const quantitativos = {
        'REGULACAO': filaPacientes.filter(p => p.setor === 'Regulação' && p.status === 'LOBBY').length,
        'COMPLEXIDADE': filaPacientes.filter(p => p.setor === 'Complexidade' && p.status === 'LOBBY').length,
        'AUTORIZACAO': filaPacientes.filter(p => p.setor === 'Autorização' && p.status === 'LOBBY').length
    };
    io.emit('atualizar_contagem_paineis', quantitativos);
}

function enfileirarChamadaTV(pacoteDeChamada) {
    if (tvFalando) {
        filaDeEsperaTV.push(pacoteDeChamada);
    } else {
        executarDisparoTV(pacoteDeChamada);
    }
}

function executarDisparoTV(pacoteDeChamada) {
    tvFalando = true;
    io.emit('bloqueio_tv_ocupada', pacoteDeChamada);
    io.emit('tocar_chamada_tv', pacoteDeChamada);
    clearTimeout(timerSegurancaTV);
    timerSegurancaTV = setTimeout(() => {
        liberarServidorEProximo();
    }, 7000);
}

function liberarServidorEProximo() {
    if (filaDeEsperaTV.length > 0) {
        const proximaChamada = filaDeEsperaTV.shift();
        executarDisparoTV(proximaChamada);
    } else {
        tvFalando = false;
        io.emit('liberar_botoes_tv_livre');
    }
}

function extrairFichaComRegra(setorNome, prefixoPadrao) {
    const turnoAtual = turnos[setorNome];
    const siglaAlvo = (turnoAtual === 'P') ? `${prefixoPadrao}P` : prefixoPadrao;
    let index = filaPacientes.findIndex(f => f.fila === siglaAlvo && f.status === 'LOBBY');
    
    if (index === -1) {
        const siglaAlternativa = (turnoAtual === 'P') ? prefixoPadrao : `${prefixoPadrao}P`;
        index = filaPacientes.findIndex(f => f.fila === siglaAlternativa && f.status === 'LOBBY');
    }

    if (index !== -1) {
        const ficha = filaPacientes[index];
        ficha.status = 'SALA';
        turnos[setorNome] = (turnos[setorNome] === 'P') ? 'N' : 'P';
        return ficha;
    }
    return null;
}

io.on('connection', (socket) => {
    socket.emit('atualizar_fila', filaPacientes);
    socket.emit('atualizar_painel_setores', ultimosChamados);
    enviarQuantitativosFila();
    socket.emit('estado_servidor', obterEstadoAtual());
    socket.emit('atualizar_media_setores', calcularMediaPorSetor());
    socket.emit('atualizar_estatisticas_absenteismo', calcularEstatisticasAbsenteismo());

    socket.on('estou_online', (nome) => {
        operadoresOnline[socket.id] = nome;
        io.emit('operadores_online_atualizados', Array.from(new Set(Object.values(operadoresOnline))));
    });

    socket.on('disconnect', () => {
        if(operadoresOnline[socket.id]) {
            delete operadoresOnline[socket.id];
            io.emit('operadores_online_atualizados', Array.from(new Set(Object.values(operadoresOnline))));
        }
    });

    socket.on('toggleFichaFisica', (idFicha) => {
        if (fichasDesativadas.has(idFicha)) fichasDesativadas.delete(idFicha); 
        else fichasDesativadas.add(idFicha); 
    });

    socket.on('resetarLoteFisico', (prefixo) => {
        fichasDesativadas.forEach(ficha => {
            if (ficha.startsWith(`${prefixo}-`)) fichasDesativadas.delete(ficha);
        });
    });

    socket.on('pedir_dados_auditoria', () => {
        socket.emit('receber_dados_auditoria', historicoAtendimentos);
    });

    socket.on('pedir_minha_producao', (nomeOperador) => {
        const dataHoje = getDataString(); 
        const meusAtendimentos = historicoAtendimentos.filter(ficha => 
            ficha.atendente === nomeOperador && ficha.data === dataHoje && ficha.resultado === 'atendido'
        );
        socket.emit('receber_minha_producao', meusAtendimentos.length);
    });

    // === GERAÇÃO E IMPRESSÃO ===
    socket.on('adicionar_ficha', (dados) => {
        const prefixo = dados.filaOpcao;
        let limite = limitesFichas[prefixo] || 160; 
        let tentatives = 0;
        let numeroValidado = contadores[prefixo]; 

        while (tentatives < limite) {
            let numeroFormatado = contadores[prefixo].toString().padStart(2, '0');
            let idFicha = `${prefixo}-${numeroFormatado}`; 
            if (!fichasDesativadas.has(idFicha)) {
                numeroValidado = contadores[prefixo];
                contadores[prefixo]++;
                if (contadores[prefixo] > limite) contadores[prefixo] = 1;
                break; 
            }
            contadores[prefixo]++;
            if (contadores[prefixo] > limite) contadores[prefixo] = 1;
            tentatives++;
        }

        const numeroString = numeroValidado.toString().padStart(2, '0');
        const codigoFicha = `${prefixo} ${numeroString}`;

        const novaFicha = {
            id: Date.now().toString(),
            ficha: codigoFicha,
            nome: dados.nome ? dados.nome.trim() : '',
            setor: mapeamentoSetores[prefixo] || 'Regulação',
            fila: prefixo,
            status: 'LOBBY',
            horarioEmissao: new Date().toISOString(),
            horarioAtendimento: null
        };

        filaPacientes.push(novaFicha);
        io.emit('comando_imprimir_senha', novaFicha);
        io.emit('atualizar_fila', filaPacientes);
        enviarQuantitativosFila();
        emitirEstadoCompleto();
        salvarDados();
    });

    socket.on('chamar_para_atendimento', (setorDoPainel) => {
        if (tvFalando) return;
        let setor = setorDoPainel;
        let guiche = null;
        if (typeof setorDoPainel === 'object' && setorDoPainel !== null) {
            setor = setorDoPainel.setor;
            guiche = setorDoPainel.guiche || null;
        }

        const nomeSetorReal = (setor === 'REGULACAO') ? 'Regulação' : (setor === 'COMPLEXIDADE') ? 'Complexidade' : 'Autorização';
        const prefixo = (setor === 'REGULACAO') ? 'R' : (setor === 'COMPLEXIDADE') ? 'C' : 'AT';
        let pacienteEscolhido;
        
        if (setor === 'AUTORIZACAO') {
            let idx = filaPacientes.findIndex(p => p.setor === 'Autorização' && p.status === 'LOBBY');
            if (idx !== -1) {
                pacienteEscolhido = filaPacientes[idx];
                pacienteEscolhido.status = 'SALA';
            }
        } else {
            pacienteEscolhido = extrairFichaComRegra(setor, prefixo);
        }

        if (pacienteEscolhido) {
            pacienteEscolhido.horarioAtendimento = new Date().toISOString();
            ultimosChamados[nomeSetorReal].unshift({ ficha: pacienteEscolhido.ficha, nome: pacienteEscolhido.nome });
            if (ultimosChamados[nomeSetorReal].length > 2) ultimosChamados[nomeSetorReal].pop();
            const pacoteDeChamada = { ficha: pacienteEscolhido.ficha, nome: pacienteEscolhido.nome, guiche };
            enfileirarChamadaTV(pacoteDeChamada);

            socket.emit('paciente_enviado_para_mesa', { paciente: pacienteEscolhido, guiche });
            io.emit('atualizar_painel_setores', ultimosChamados);
            io.emit('atualizar_fila', filaPacientes);
            enviarQuantitativosFila();
            emitirEstadoCompleto();
            salvarDados();
        } else {
            socket.emit('erro_sem_paciente_na_sala', 'Não há pacientes aguardando para o seu setor.');
        }
    });

    socket.on('rechamar_paciente_tv', (pacienteRechamado) => {
        const pacoteDeChamada = { ficha: pacienteRechamado.ficha, nome: pacienteRechamado.nome, guiche: pacienteRechamado.guiche };
        enfileirarChamadaTV(pacoteDeChamada);
    });

    socket.on('registrar_conclusao_atendimento', (dados) => {
        const { setor, resultado, idFicha, operador, ubs, procedimentos, redeOrigem } = dados;
        const atendente = operador || 'Desconhecido';
        const idx = filaPacientes.findIndex(p => p.id === idFicha || p.ficha === dados.siglaFicha);

        if (idx !== -1) {
            const paciente = filaPacientes[idx];
            const horaChegada = paciente.horarioEmissao || new Date(Number(paciente.id)).toISOString();
            const horaAtendimento = paciente.horarioAtendimento || new Date().toISOString();
            const tempoEspera = Math.max(0, Math.round((new Date(horaAtendimento) - new Date(horaChegada)) / 60000));

            historicoAtendimentos.push({
                id: paciente.id, ficha: paciente.ficha, setor: paciente.setor, horaChegada, horaAtendimento,
                atendente, tempoEspera, resultado, ubs: ubs || 'Não informada', procedimentos: procedimentos || 'Nenhum',
                redeOrigem: redeOrigem || 'Não informada', data: getDataString() 
            });

            filaPacientes.splice(idx, 1);
            if (resultado === 'atendido') atendimentosPorOperador[atendente] = (atendimentosPorOperador[atendente] || 0) + 1;
            if (resultado === 'falta' && setor !== 'AUTORIZACAO') {
                const isPriority = paciente.fila.endsWith('P');
                turnos[setor] = isPriority ? 'P' : 'N';
            }
            io.emit('atualizar_fila', filaPacientes);
            enviarQuantitativosFila();
            emitirEstadoCompleto();
            salvarDados();
        }
        socket.emit('guiche_liberado_com_sucesso');
    });

    socket.on('tv_terminou_de_falar', () => {
        clearTimeout(timerSegurancaTV); 
        liberarServidorEProximo();
    });

    socket.on('excluir_ficha', (idFicha) => {
        filaPacientes = filaPacientes.filter(p => p.id !== idFicha);
        io.emit('atualizar_fila', filaPacientes);
        enviarQuantitativosFila();
        emitirEstadoCompleto();
        salvarDados();
    });

    socket.on('resetar_sistema', () => {
        realizarResetGeral();
    });
});

async function iniciarServidor() {
    // Agora ele carrega da nuvem primeiro, se falhar, vai pro disco local!
    await carregarDados(); 
    agendarResetMeiaNoite();
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => console.log(`🚀 Motor Híbrido rodando na porta ${PORT}`));
}

iniciarServidor();
