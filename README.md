# Se Fode

Jogo de cartas multiplayer em tempo real inspirado no “Fodinha”. Crie uma sala, compartilhe o código e jogue no navegador com 2 a 8 pessoas.

Também há um modo solo contra o **Bot Fodão**, ideal para aprender as regras e testar uma partida completa.

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
- A manilha é o valor seguinte ao vira; entre manilhas, `♦ ♠ ♥ ♣`.
- Cartas de mesma força melam. Se todas melarem, ninguém leva a vaza.
- O pé da mesa nunca pode fechar a soma das apostas no número de cartas, inclusive na rodada de uma carta.
- Cada erro entre aposta e resultado custa uma vida. Todos começam com cinco.
- O número de cartas sobe até o limite do baralho, desce até uma e então inicia um novo ciclo.
