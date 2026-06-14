const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// --- MEMÓRIA CENTRAL DO SISTEMA ---
let filaPacientes = []; 
let contadores = { 'RP': 1, 'R': 1, 'CP': 1, 'C': 1, 'AT': 1 };
let turnos = { 'REGULACAO': 'P', 'COMPLEXIDADE': 'P', 'AUTORIZACAO': 'P' };

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
// #region agent log
function dbgLog(location, message, data, hypothesisId) {
    try {
        fs.appendFileSync(DEBUG_LOG, JSON.stringify({ sessionId: '38e5fb', location, message, data, hypothesisId, timestamp: Date.now(), runId: 'pre-fix' }) + '\n');
    } catch (e) { /* ignore */ }
}
// #endregion

function getDataString() {
    return new Date().toISOString().slice(0, 10);
}

let atendimentosPorOperador = {};
let statusDia = { aberto: true, data: getDataString() };
let historicoAtendimentos = [];
let pendingWrite = null;
let lastWriteContent = null;

function obterEstadoAtual() {
    return {
        filaPacientes,
        contadores,
        turnos,
        ultimosChamados,
        statusDia,
        atendimentosPorOperador
    };
}

function salvarDados() {
    const dataString = JSON.stringify({
        filaPacientes,
        contadores,
        turnos,
        ultimosChamados,
        statusDia,
        atendimentosPorOperador,
        historicoAtendimentos
    }, null, 2);

    lastWriteContent = dataString;

    if (pendingWrite) {
        return pendingWrite;
    }

    pendingWrite = fsPromises.writeFile(dadosPath, dataString, 'utf8')
        .catch((err) => {
            console.error('❌ Erro ao salvar dados.json:', err);
        })
        .then(() => {
            pendingWrite = null;
            if (lastWriteContent !== dataString) {
                salvarDados();
            }
        });

    return pendingWrite;
}

async function carregarDados() {
    try {
        await fsPromises.access(dadosPath, fs.constants.F_OK);
        const raw = await fsPromises.readFile(dadosPath, 'utf8');
        const dados = JSON.parse(raw);

        if (dados && Array.isArray(dados.filaPacientes)) filaPacientes = dados.filaPacientes;
        if (dados && typeof dados.contadores === 'object' && dados.contadores !== null) contadores = dados.contadores;
        if (dados && typeof dados.turnos === 'object' && dados.turnos !== null) {
            turnos = Object.assign({ 'REGULACAO': 'P', 'COMPLEXIDADE': 'P', 'AUTORIZACAO': 'P' }, dados.turnos);
        }
        if (dados && typeof dados.ultimosChamados === 'object' && dados.ultimosChamados !== null) ultimosChamados = dados.ultimosChamados;
        if (dados && typeof dados.statusDia === 'object' && dados.statusDia !== null) statusDia = dados.statusDia;
        if (dados && typeof dados.atendimentosPorOperador === 'object' && dados.atendimentosPorOperador !== null) atendimentosPorOperador = dados.atendimentosPorOperador;
        if (dados && Array.isArray(dados.historicoAtendimentos)) historicoAtendimentos = dados.historicoAtendimentos;

        reconstruirContagens();
        console.log('✅ Dados carregados de dados.json');
        // #region agent log
        dbgLog('server.js:carregarDados', 'dados carregados ok', { filaLen: filaPacientes.length, contadores }, 'A');
        // #endregion
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error('❌ Erro ao carregar dados.json:', err);
        }
        // #region agent log
        dbgLog('server.js:carregarDados', 'falha ao carregar dados', { errCode: err.code, errMsg: err.message }, 'A');
        // #endregion
    }
}

function reconstruirContagens() {
    atendimentosPorOperador = {};
    const hoje = getDataString(); // Pega a data atual (AAAA-MM-DD)
    
    historicoAtendimentos.forEach(item => {
        // Só conta no painel se foi atendido HOJE
        if (item.resultado === 'atendido' && item.atendente && item.data === hoje) {
            atendimentosPorOperador[item.atendente] = (atendimentosPorOperador[item.atendente] || 0) + 1;
        }
    });
}

function calcularMediaPorSetor() {
    const hoje = getDataString();
    const setores = { REGULACAO: [], COMPLEXIDADE: [], AUTORIZACAO: [] };

    historicoAtendimentos.forEach(item => {
        if (item.resultado !== 'atendido') return;
        if (!item.horaAtendimento) return;
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
}

const mapeamentoSetores = {
    'RP': 'Regulação', 'R': 'Regulação',
    'CP': 'Complexidade', 'C': 'Complexidade',
    'AT': 'Autorização'
};

// 🌟 FUNÇÃO DE RESET COMPLETO (PRESERVA O HISTÓRICO MORTO)
function realizarResetGeral() {
    clearTimeout(timerSegurancaTV);
    
    // Limpa apenas as filas operacionais do dia
    filaPacientes = []; 
    filaDeEsperaTV = []; 
    tvFalando = false; 
    
    // Reseta as senhas para voltarem a emitir a partir do 01 de manhã
    contadores = { 'RP': 1, 'R': 1, 'CP': 1, 'C': 1, 'AT': 1 };
    turnos = { 'REGULACAO': 'P', 'COMPLEXIDADE': 'P', 'AUTORIZACAO': 'P' };
    
    ultimosChamados = {
        'Regulação': [ { ficha: '---', nome: 'Nenhum' }, { ficha: '---', nome: 'Nenhum' } ],
        'Complexidade': [ { ficha: '---', nome: 'Nenhum' }, { ficha: '---', nome: 'Nenhum' } ],
        'Autorização': [ { ficha: '---', nome: 'Nenhum' }, { ficha: '---', nome: 'Nenhum' } ]
    };
    
    statusDia = { aberto: true, data: getDataString() };
    
    // Avisa todas as telas que o dia virou
    io.emit('atualizar_fila', filaPacientes);
    io.emit('atualizar_painel_setores', ultimosChamados);
    enviarQuantitativosFila();
    io.emit('liberar_botoes_tv_livre');
    io.emit('limpar_tv'); 
    
    // Força os painéis dos reguladores a pedirem a contagem nova (que vai dar 0 por causa da nova data)
    io.emit('sistema_resetado');
    
    emitirEstadoCompleto();
    salvarDados(); // Salva no dados.json mantendo o historicoAtendimentos guardado!
    console.log(`⏰ Mudança de turno concluída! Novo dia iniciado: ${statusDia.data}`);
}

// 🌟 TIMER AUTOMÁTICO PARA A MEIA-NOITE
function agendarResetMeiaNoite() {
    const agora = new Date();
    const meiaNoite = new Date();
    
    meiaNoite.setHours(24, 0, 0, 0); // Define para a próxima meia-noite
    
    const tempoAteMeiaNoite = meiaNoite.getTime() - agora.getTime();
    
    setTimeout(() => {
        realizarResetGeral();
        // Depois do primeiro reset, agenda para rodar a cada 24 horas
        setInterval(realizarResetGeral, 24 * 60 * 60 * 1000);
    }, tempoAteMeiaNoite);
}

// 🌟 SISTEMA ANTI-COCHILO (PING AUTOMÁTICO A CADA 10 MINUTOS)
const URL_DO_SEU_SISTEMA = "https://painel-da-regulacao.onrender.com"; 

setInterval(() => {
    https.get(URL_DO_SEU_SISTEMA, (res) => {
        console.log("🔄 Ping enviado para manter o servidor acordado.");
    }).on('error', (err) => {
        console.log("❌ Erro no ping anti-cochilo:", err.message);
    });
}, 10 * 60 * 1000); // 10 minutos em milissegundos


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
    // Envia pacote completo (ficha, nome, guiche) para a TV
    io.emit('tocar_chamada_tv', pacoteDeChamada);
    // #region agent log
    dbgLog('server.js:executarDisparoTV', 'tv disparo iniciado', { ficha: pacoteDeChamada.ficha, filaEsperaLen: filaDeEsperaTV.length }, 'C');
    // #endregion

    clearTimeout(timerSegurancaTV);
    timerSegurancaTV = setTimeout(() => {
        // #region agent log
        dbgLog('server.js:timerSegurancaTV', 'timer 7s expirou liberando tv', { ficha: pacoteDeChamada.ficha }, 'C');
        // #endregion
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
        // #region agent log
        dbgLog('server.js:liberarServidorEProximo', 'tv liberada', {}, 'C');
        // #endregion
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

    // DEVOLVE A PRODUÇÃO DIÁRIA PARA A TELA DO OPERADOR
    socket.on('pedir_minha_producao', (nomeOperador) => {
        const dataHoje = getDataString(); // Consistência com a formatação AAAA-MM-DD
        
        // Filtra no histórico APENAS as fichas de hoje, deste operador, que foram 'atendidas'
        const meusAtendimentos = historicoAtendimentos.filter(ficha => 
            ficha.atendente === nomeOperador && 
            ficha.data === dataHoje && 
            ficha.resultado === 'atendido'
        );

        // Manda a quantidade de volta para a tela do operador
        socket.emit('receber_minha_producao', meusAtendimentos.length);
    });

    socket.on('adicionar_ficha', (dados) => {
        const numero = contadores[dados.filaOpcao].toString().padStart(2, '0');
        const codigoFicha = `${dados.filaOpcao} ${numero}`;
        contadores[dados.filaOpcao]++;

        const novaFicha = {
            id: Date.now().toString(),
            ficha: codigoFicha,
            nome: dados.nome ? dados.nome.trim() : '',
            setor: mapeamentoSetores[dados.filaOpcao] || 'Regulação',
            fila: dados.filaOpcao,
            status: 'LOBBY',
            horarioEmissao: new Date().toISOString(),
            horarioAtendimento: null
        };

        filaPacientes.push(novaFicha);
        io.emit('atualizar_fila', filaPacientes);
        enviarQuantitativosFila();
        emitirEstadoCompleto();
        salvarDados();
    });

    socket.on('chamar_para_atendimento', (setorDoPainel) => {
        if (tvFalando) {
            // #region agent log
            dbgLog('server.js:chamar_para_atendimento', 'bloqueado tvFalando', { setorDoPainel }, 'D');
            // #endregion
            return;
        }
        // aceitar tanto string (antigo) quanto objeto { setor, guiche }
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
        const pacoteDeChamada = { 
            ficha: pacienteRechamado.ficha, 
            nome: pacienteRechamado.nome,
            guiche: pacienteRechamado.guiche // Agora o servidor repassa a informação do guichê!
        };
        enfileirarChamadaTV(pacoteDeChamada);
    });

    socket.on('registrar_conclusao_atendimento', (dados) => {
        const { setor, resultado, idFicha, operador } = dados;
        const atendente = operador || 'Desconhecido';
        
        // Procura o paciente na fila ativa
        const idx = filaPacientes.findIndex(p => p.id === idFicha || p.ficha === dados.siglaFicha);

        if (idx !== -1) {
            const paciente = filaPacientes[idx];
            const horaChegada = paciente.horarioEmissao || new Date(Number(paciente.id)).toISOString();
            const horaAtendimento = paciente.horarioAtendimento || new Date().toISOString();
            const tempoEspera = Math.max(0, Math.round((new Date(horaAtendimento) - new Date(horaChegada)) / 60000));

            // Grava no Array do Arquivo Morto
            historicoAtendimentos.push({
                id: paciente.id,
                ficha: paciente.ficha,
                setor: paciente.setor,
                horaChegada,
                horaAtendimento,
                atendente,
                tempoEspera,
                resultado,
                data: getDataString() // Salva no formato AAAA-MM-DD estável
            });

            // Remove o paciente da fila ativa de memória para o painel não ficar pesado
            filaPacientes.splice(idx, 1);

            // Atualiza a contagem rápida de hoje na RAM
            if (resultado === 'atendido') {
                atendimentosPorOperador[atendente] = (atendimentosPorOperador[atendente] || 0) + 1;
            }

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
        // #region agent log
        dbgLog('server.js:tv_terminou_de_falar', 'evento recebido da tv', {}, 'C');
        // #endregion
        clearTimeout(timerSegurancaTV); 
        liberarServidorEProximo();
    });

    socket.on('resposta_estado_cliente', (estado) => {
        // #region agent log
        dbgLog('server.js:resposta_estado_cliente', 'cliente enviou estado mas servidor nao restaura', { filaLen: estado && estado.filaPacientes ? estado.filaPacientes.length : null }, 'E');
        // #endregion
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
    await carregarDados();
    agendarResetMeiaNoite();
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => console.log(`🚀 Motor rodando na porta ${PORT}`));
}

iniciarServidor();
