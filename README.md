# Se Fode

Jogo de cartas multiplayer em tempo real inspirado no “Fodinha”. Crie uma sala, compartilhe o código e jogue no navegador com 2 a 8 pessoas.

Também há um modo solo com escolha de **1 a 7 bots**, ideal para aprender as regras e testar uma partida completa.
Os bots podem jogar nos níveis **fácil**, **normal** ou **difícil**.
Partidas online recuperam automaticamente o jogador após uma queda ou recarga da página; se ele não voltar, o jogo assume seu turno para não travar a mesa.

## Rodar localmente

```bash
npm install
npm start
```

Abra `http://localhost:3000`. Para jogar entre aparelhos na mesma rede, abra o endereço IP do computador na porta 3000. Para jogar pela internet, publique o servidor Node em um serviço com suporte a WebSockets.

## Hospedar no Render

O projeto inclui um `render.yaml` pronto para criar gratuitamente um Web Service na região da Virgínia, com health check em `/health` e deploy automático a cada atualização da branch `main`.

## Regras adotadas

- Baralho de truco com 40 cartas; ordem `4 5 6 7 Q J K A 2 3`.
- As manilhas são fixas como no truco mineiro: `4♣ > 7♥ > A♠ > 7♦`.
- Uma **mão** é composta por várias **rodadas** — uma para cada carta distribuída.
- Cartas de mesma força melam aos pares, na ordem em que foram jogadas (3 iguais: as 2 primeiras melam, a 3ª sobrevive).
- Rodada que mela inteira acumula: a próxima vale por duas, e assim por diante, até alguém vencer e levar tudo. Se a mão acabar melada, o bolo vai para quem venceu a rodada antes da melada.
- O pé da mesa nunca pode fechar a soma das apostas no número de cartas, inclusive na mão de uma carta.
- Cada erro entre aposta e resultado custa uma vida. Todos começam com cinco.
- O número de cartas sobe até o limite do baralho, desce até uma e então inicia um novo ciclo.
