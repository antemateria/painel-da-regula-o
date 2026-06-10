const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

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

const mapeamentoSetores = {
    RP: 'Regulação', R: 'Regulação',
    CP: 'Complexidade', C: 'Complexidade',
    AT: 'Autorização'
};

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
    console.log('⏰ Sistema resetado automaticamente!');
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
    http.get(URL_DO_SEU_SISTEMA, (res) => {
        console.log("🔄 Ping enviado para manter o servidor acordado.");
    }).on('error', (err) => {
        console.log("❌ Erro no ping anti-cochilo:", err.message);
    });
}, 10 * 60 * 1000);

agendarResetMeiaNoite();

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

function ejecutarDisparoTV(pacoteDeChamada) {
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
    });

    socket.on('resetar_sistema', () => {
        realizarResetGeral();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Motor rodando na porta ${PORT}`));
