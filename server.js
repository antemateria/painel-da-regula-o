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
let turnos = { 'REGULACAO': 'P', 'COMPLEXIDADE': 'P' };

let ultimosChamados = {
    'Regulação': [ { ficha: '---', nome: 'Nenhum' }, { ficha: '---', nome: 'Nenhum' } ],
    'Complexidade': [ { ficha: '---', nome: 'Nenhum' }, { ficha: '---', nome: 'Nenhum' } ],
    'Autorização': [ { ficha: '---', nome: 'Nenhum' }, { ficha: '---', nome: 'Nenhum' } ]
};

let filaDeEsperaTV = []; 
let tvFalando = false;   
let timerSegurancaTV = null;

const dadosPath = path.join(__dirname, 'dados.json');

function obterEstadoAtual() {
    return {
        filaPacientes,
        contadores,
        turnos,
        ultimosChamados
    };
}

function salvarDados() {
    try {
        fs.writeFileSync(dadosPath, JSON.stringify(obterEstadoAtual(), null, 2), 'utf8');
    } catch (err) {
        console.error('❌ Erro ao salvar dados.json:', err);
    }
}

function carregarDados() {
    try {
        if (!fs.existsSync(dadosPath)) return;
        const raw = fs.readFileSync(dadosPath, 'utf8');
        const dados = JSON.parse(raw);

        if (dados && Array.isArray(dados.filaPacientes)) filaPacientes = dados.filaPacientes;
        if (dados && typeof dados.contadores === 'object' && dados.contadores !== null) contadores = dados.contadores;
        if (dados && typeof dados.turnos === 'object' && dados.turnos !== null) turnos = dados.turnos;
        if (dados && typeof dados.ultimosChamados === 'object' && dados.ultimosChamados !== null) ultimosChamados = dados.ultimosChamados;

        console.log('✅ Dados carregados de dados.json');
    } catch (err) {
        console.error('❌ Erro ao carregar dados.json:', err);
    }
}

function emitirEstadoCompleto() {
    io.emit('estado_servidor', obterEstadoAtual());
}

const mapeamentoSetores = {
    'RP': 'Regulação', 'R': 'Regulação',
    'CP': 'Complexidade', 'C': 'Complexidade',
    'AT': 'Autorização'
};

// 🌟 FUNÇÃO DE RESET COMPLETO (USADA NO BOTÃO E NO TIMER DA MEIA-NOITE)
function realizarResetGeral() {
    clearTimeout(timerSegurancaTV);
    filaPacientes = []; filaDeEsperaTV = []; tvFalando = false; 
    contadores = { 'RP': 1, 'R': 1, 'CP': 1, 'C': 1, 'AT': 1 };
    turnos = { 'REGULACAO': 'P', 'COMPLEXIDADE': 'P' };
    ultimosChamados = {
        'Regulação': [ { ficha: '---', nome: 'Nenhum' }, { ficha: '---', nome: 'Nenhum' } ],
        'Complexidade': [ { ficha: '---', nome: 'Nenhum' }, { ficha: '---', nome: 'Nenhum' } ],
        'Autorização': [ { ficha: '---', nome: 'Nenhum' }, { ficha: '---', nome: 'Nenhum' } ]
    };
    io.emit('atualizar_fila', filaPacientes);
    io.emit('atualizar_painel_setores', ultimosChamados);
    enviarQuantitativosFila();
    io.emit('liberar_botoes_tv_livre');
    io.emit('limpar_tv'); 
    io.emit('sistema_resetado');
    emitirEstadoCompleto();
    salvarDados();
    console.log("⏰ Sistema resetado automaticamente!");
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
agendarResetMeiaNoite(); // Ativa o agendamento ao ligar o servidor

// 🌟 SISTEMA ANTI-COCHILO (PING AUTOMÁTICO A CADA 10 MINUTOS)
// Substitua o link abaixo pelo link VERDE real que o Render te deu!
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
    io.emit('tocar_chamada_tv', { ficha: pacoteDeChamada.ficha });

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
            status: 'LOBBY'
        };

        filaPacientes.push(novaFicha);
        io.emit('atualizar_fila', filaPacientes);
        enviarQuantitativosFila();
        emitirEstadoCompleto();
        salvarDados();
    });

    socket.on('chamar_para_atendimento', (setorDoPainel) => {
        if (tvFalando) return; 

        const nomeSetorReal = (setorDoPainel === 'REGULACAO') ? 'Regulação' : (setorDoPainel === 'COMPLEXIDADE') ? 'Complexidade' : 'Autorização';
        const prefixo = (setorDoPainel === 'REGULACAO') ? 'R' : (setorDoPainel === 'COMPLEXIDADE') ? 'C' : 'AT';
        
        let pacienteEscolhido;
        
        if (setorDoPainel === 'AUTORIZACAO') {
            let idx = filaPacientes.findIndex(p => p.setor === 'Autorização' && p.status === 'LOBBY');
            if (idx !== -1) {
                pacienteEscolhido = filaPacientes[idx];
                pacienteEscolhido.status = 'SALA';
            }
        } else {
            pacienteEscolhido = extrairFichaComRegra(setorDoPainel, prefixo);
        }

        if (pacienteEscolhido) {
            ultimosChamados[nomeSetorReal].unshift({ ficha: pacienteEscolhido.ficha, nome: pacienteEscolhido.nome });
            if (ultimosChamados[nomeSetorReal].length > 2) ultimosChamados[nomeSetorReal].pop();

            const pacoteDeChamada = { ficha: pacienteEscolhido.ficha, nome: pacienteEscolhido.nome };
            enfileirarChamadaTV(pacoteDeChamada);

            socket.emit('paciente_enviado_para_mesa', { paciente: pacienteEscolhido });
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
        const pacoteDeChamada = { ficha: pacienteRechamado.ficha, nome: pacienteRechamado.nome };
        enfileirarChamadaTV(pacoteDeChamada);
    });

    socket.on('registrar_conclusao_atendimento', (dados) => {
        const { setor, resultado, siglaFicha } = dados;

        if (resultado === 'falta' && setor !== 'AUTORIZACAO') {
            const isPriority = siglaFicha.endsWith('P');
            turnos[setor] = isPriority ? 'P' : 'N';
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

carregarDados();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Motor rodando na porta ${PORT}`));
