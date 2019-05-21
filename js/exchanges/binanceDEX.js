/* eslint-disable max-len,class-methods-use-this */
import CryptoJS from 'crypto-js';
import ReWS from 'reconnecting-websocket';
import { Decimal } from 'decimal.js';
import Exchanges from './baseExchange';

const RecvWindow = 60000;

export default class binanceDEX extends Exchanges {
  constructor(data = {}) {
    super();
    this.name = 'Binance';
    this._mainUrl = 'wss://testnet-dex.binance.org/api/ws/';
    this._sockets = {};
    this._proxy = data.proxy || '';

    this._key = data.key;
    this._secret = data.secret;

    this.BASE = `${this._proxy}https://api.binance.com`;

    this.orderBook = symbol =>
      `${this._proxy}https://dex.binance.org/api/v1/depth?symbol=${symbol}&limit=1000`;

    this.trades = symbol =>
      `${this._proxy}https://dex.binance.org/api/v1/trades?symbol=${symbol}&limit=20`;

    this.streams = {
      depth: symbol => `${symbol.toLowerCase()}@marketDiff`,
      kline: (symbol, interval) => `${symbol.toLowerCase()}@kline_${this.times[interval]}`,
      trade: symbol => `${symbol.toLowerCase()}@trades`
    };
    this.times = {
      1: '1m',
      3: '3m',
      5: '5m',
      15: '15m',
      30: '30m',
      60: '1h',
      120: '2h',
      240: '4h',
      360: '6h',
      480: '8h',
      720: '12h',
      '1D': '1d',
      '3D': '3d',
      '1W': '1w',
      '1M': '1M'
    };

    this.status = {
      NEW: 'open',
      PARTIALLY_FILLED: 'open',
      FILLED: 'closed',
      CANCELED: 'canceled',
      REJECTED: 'canceled',
      EXPIRED: 'canceled'
    };

    this.type = {
      LIMIT: 'limit',
      MARKET: 'market',
      STOP_LOSS: 'stop_loss',
      STOP_LOSS_LIMIT: 'stop_loss_limit',
      TAKE_PROFIT: 'take_profit',
      TAKE_PROFIT_LIMIT: 'take_profit_limit',
      LIMIT_MAKER: 'limit_maker'
    };

    this.types = {
      limit: 'LIMIT',
      market: 'MARKET',
      stop_loss: 'STOP_LOSS',
      stop_loss_limit: 'STOP_LOSS_LIMIT',
      take_profit: 'TAKE_PROFIT',
      take_profit_limit: 'TAKE_PROFIT_LIMIT'
    };

    this.stable_coins = ['USD', 'USDT', 'PAX', 'SDC'];
    this.toOrig = {};
    this.fromOrig = {};

    fetch(`${this._proxy}https://dex.binance.org/api/v1/tokens`).then(r => r.json()).then(rawCoins => {
      console.log('rawCoins', rawCoins);
      rawCoins.forEach(coin => {
        this.toOrig[coin.symbol] = coin.original_symbol;
        this.fromOrig[coin.original_symbol] = coin.symbol;
      });
      console.log(this.fromOrig);
      console.log(this.toOrig);
    });
  }

  getOrderTypes() {
    return ['limit'];
  }

  getExchangeConfig() {
    return {
      exchange: {
        isActive: true,
        componentList: ['open', 'history', 'balance'],
        orderTypes: ['limit']
      },
      margin: {
        isActive: false
      },
      intervals: this.getSupportedInterval()
    };
  }


  _setupWebSocket(eventHandler, path, type) {
    if (this._sockets[type]) {
      this._sockets[type].close();
    }
    const fullPath = this._mainUrl + path;
    this._sockets[type] = new ReWS(fullPath, [], {
      WebSocket,
      connectionTimeout: 5000,
      debug: false
    });

    this._sockets[type].onmessage = event => {
      const res = JSON.parse(event.data);
      eventHandler(res);
    };
    return this._sockets[type];
  }

  closeTrade() {
    if (this._sockets.trade) this._sockets.trade.close();
  }

  closeOB() {
    if (this._sockets.orderbook) this._sockets.orderbook.close();
  }

  closeKline() {
    if (this._sockets.kline) this._sockets.kline.close();
  }

  onTrade(symbol, eventHandler) {
    const splitSymbol = symbol.split(/[:/]/);
    const newSymbol = this.fromOrig[splitSymbol[0]] + '_' + this.fromOrig[splitSymbol[1]];

    const handler = res => {
      const side = res.m ? 'sell' : 'buy';
      const trade = {
        id: res.f,
        side,
        timestamp: res.T,
        price: +res.p,
        amount: +res.q,
        symbol: res.s,
        exchange: 'binance'
      };
      eventHandler(trade);
    };

    fetch(this.trades(newSymbol))
      .then(r => r.json())
      .then(res => {
        res.forEach(raw => {
          const side = raw.isBuyerMaker ? 'buy' : 'sell';
          const trade = {
            id: raw.id,
            side,
            timestamp: raw.time,
            price: +raw.price,
            amount: +raw.qty,
            symbol,
            exchange: 'binance'
          };
          eventHandler(trade);
        });
        return this._setupWebSocket(handler, this.streams.trade(newSymbol), 'trade');
      });
  }

  onDepthUpdate(symbol, eventHandler) {
    const splitSymbol = symbol.split(/[:/]/);
    const newSymbol = this.fromOrig[splitSymbol[0]] + '_' + this.fromOrig[splitSymbol[1]];
    const uBuffer = {
      asks: [],
      bids: [],
      type: 'update',
      exchange: 'binance',
      symbol
    };
    let SnapshotAccepted = false;

    fetch(this.orderBook(newSymbol))
      .then(r => r.json())
      .then(res => {
        const data = {
          asks: [],
          bids: [],
          type: 'snapshot',
          exchange: 'binance',
          symbol
        };
        res.asks.forEach(r => data.asks.push([+r[0], +r[1]]));
        res.bids.forEach(r => data.bids.push([+r[0], +r[1]]));
        eventHandler(data);
      });

    const handler = res => {
      if (SnapshotAccepted) {
        const data = {
          asks: [],
          bids: [],
          type: 'update',
          exchange: 'binance',
          symbol
        };
        res.a.forEach(r => data.asks.push([+r[0], +r[1]]));
        res.b.forEach(r => data.bids.push([+r[0], +r[1]]));
        eventHandler(data);
      } else {
        res.a.forEach(r => uBuffer.asks.push([+r[0], +r[1]]));
        res.b.forEach(r => uBuffer.bids.push([+r[0], +r[1]]));
      }
    };
    const socket = this._setupWebSocket(handler, this.streams.depth(newSymbol), 'orderbook');
    socket.onopen = () => {
      fetch(this.orderBook(newSymbol))
        .then(r => r.json())
        .then(res => {
          const data = {
            asks: [],
            bids: [],
            type: 'snapshot',
            exchange: 'binance',
            symbol
          };
          res.asks.forEach(r => data.asks.push([+r[0], +r[1]]));
          res.bids.forEach(r => data.bids.push([+r[0], +r[1]]));
          eventHandler(data);
          SnapshotAccepted = true;
          eventHandler(uBuffer);
        });
    };

    return socket;
  }

  onKline(symbol, interval, eventHandler) {
    const splitSymbol = symbol.split(/[:/]/);
    const newSymbol = this.fromOrig[splitSymbol[0]] + '_' + this.fromOrig[splitSymbol[1]];
    const handler = data => {
      const newData = {
        close: +data.k.c,
        high: +data.k.h,
        low: +data.k.l,
        open: +data.k.o,
        time: +data.k.t,
        volume: +data.k.v
      };
      eventHandler(newData);
    };
    return this._setupWebSocket(handler, this.streams.kline(newSymbol, interval), 'kline');
  }

  async getPairs() {
    return fetch(`${this._proxy}https://dex.binance.org/api/v1/ticker/24hr`)
      .then(r => r.json())
      .then(r => {
        const pairs = {
          BTC: [],
          ALT: [],
          STABLE: []
        };
        const fullList = {};
        r.forEach(pair => {
          const [quote, base] = pair.symbol.split('_');
          const origBase = this.toOrig[base];
          const origQuote = this.toOrig[quote];
          const symbol = `${origQuote}/${origBase}`;
          const data = {
            symbol,
            volume: +pair.quoteVolume,
            priceChangePercent: +pair.priceChangePercent,
            price: +pair.lastPrice,
            high: +pair.highPrice,
            low: +pair.lowPrice,
            quote: origQuote,
            base: origBase
          };
          if (data.price !== 0) {
            if (base === 'BTC') {
              pairs[base].push(data);
            } else if (this.stable_coins.indexOf(base) !== -1) {
              pairs.STABLE.push(data);
            } else {
              pairs.ALT.push(data);
            }
            fullList[symbol] = data;
          }
        });
        return [pairs, fullList];
      });
  }

  async getKline(pair, interval, start, end) {
    const [quote, base] = pair.split('/');
    const symbol = `${this.fromOrig[quote]}_${this.fromOrig[base]}`;
    return fetch(
      `${this._proxy}https://dex.binance.org/api/v1/klines?symbol=${symbol}&interval=${
        this.times[interval]
        }&endTime=${end * 1000}&limit=1000`
    )
      .then(r => r.json())
      .then(r => {
        const newcandle = [];
        r.map(obj =>
          newcandle.push({
            time: obj[0],
            open: +obj[1],
            high: +obj[2],
            low: +obj[3],
            close: +obj[4],
            volume: +obj[5]
          })
        );
        return newcandle;
      });
  }

  async getBalance(credentials) {
    return this._pCall('/v3/account', { recvWindow: RecvWindow }, 'GET', credentials).then(r => {
      const newData = { exchange: {} };
      if (r && r.balances) {
        r.balances.forEach(c => {
          if (+c.free !== 0 || +c.locked !== 0) {
            newData.exchange[c.asset] = {
              coin: c.asset,
              free: +c.free,
              used: +c.locked,
              total: +c.free + +c.locked
            };
          }
        });
      }
      return newData;
    });
  }

  async getOpenOrders(credentials, { pair } = {}) {
    const symbol = pair ? pair.replace('/', '') : '';
    const data = { recvWindow: RecvWindow };
    if (symbol) {
      data.symbol = symbol;
    }

    return this._pCall('/v3/openOrders', data, 'GET', credentials).then(r => {
      const newData = [];
      if (r) {
        r.forEach(order => {
          const responsePair = pair ? symbol : order.symbol;
          const base =
            responsePair.indexOf('USDT') === -1
              ? responsePair.substr(responsePair.length - 3)
              : responsePair.substr(responsePair.length - 4);
          const target =
            base === 'USDT'
              ? responsePair.substr(0, responsePair.length - 4)
              : responsePair.substr(0, responsePair.length - 3);
          const responseSymbol = `${target}/${base}`;
          newData.push({
            id: order.orderId,
            timestamp: order.time,
            lastTradeTimestamp: order.updateTime,
            status: this.status[order.status],
            symbol: responseSymbol,
            type: this.type[order.type],
            side: order.side.toLowerCase(),
            price: +order.price,
            amount: +order.origQty,
            executed: +order.executedQty,
            filled: (+order.executedQty / +order.origQty) * 100,
            remaining: +order.origQty - +order.executedQty,
            cost: order.cummulativeQuoteQty > 0 ? +order.cummulativeQuoteQty : 0,
            fee: {
              symbol: base,
              value: order.cummulativeQuoteQty > 0 ? order.cummulativeQuoteQty * 0.001 : 0
            }
          });
        });
      }
      return newData.reverse();
    });
  }

  async getAllOrders(credentials, { pair, status, orderId } = {}) {
    const symbol = pair ? pair.replace('/', '') : '';
    const data = { recvWindow: RecvWindow, symbol };
    if (!symbol) {
      throw Error('Need pass symbol argument');
    }

    if (orderId) {
      data.orderId = orderId;
    }
    return this._pCall('/v3/allOrders', data, 'GET', credentials)
      .then(r => {
        const newData = [];
        if (r) {
          if (orderId) r = r.filter(order => order.orderId === orderId);
          r.forEach(order => {
            const base = pair.split('/')[1];
            const formatedOrder = {
              id: order.orderId,
              timestamp: order.time,
              lastTradeTimestamp: order.updateTime,
              status: this.status[order.status],
              symbol: pair,
              type: this.type[order.type],
              side: order.side.toLowerCase(),
              price: +order.cummulativeQuoteQty
                ? +order.cummulativeQuoteQty / +order.executedQty
                : +order.price,
              amount: +order.origQty,
              filled: +order.executedQty,
              remaining: +order.origQty - +order.executedQty,
              cost: order.cummulativeQuoteQty > 0 ? +order.cummulativeQuoteQty : 0,
              fee: {
                symbol: base,
                value: order.cummulativeQuoteQty > 0 ? order.cummulativeQuoteQty * 0.001 : 0
              }
            };
            if ((status && formatedOrder.status === status) || !status) {
              newData.push(formatedOrder);
            }
          });
        }
        return newData.reverse();
      })
      .catch(err => {
        throw Error(err);
      });
  }

  async getClosedOrders(credentials, { pair } = {}) {
    return this.getAllOrders(credentials, { pair, status: 'closed' });
  }

  async cancelOrder(credentials, { pair, orderId } = {}) {
    const symbol = pair ? pair.replace('/', '') : '';
    const data = { recvWindow: RecvWindow, symbol, orderId };

    if (!symbol) {
      throw Error('Need pass symbol argument');
    }
    if (!orderId) {
      throw Error('Need pass orderId argument');
    }

    return this._pCall('/v3/order', data, 'DELETE', credentials).then(() =>
      this.getAllOrders(credentials, { pair, type: '', orderId })
    );
  }

  // async createOrder(credentials, data) {
  //   if (!data) {
  //     throw Error('Need pass oder data object');
  //   }
  //   if (!data.type) {
  //     throw Error('Need pass order type');
  //   }
  //   if (!data.pair) {
  //     throw Error('Need pass order pair');
  //   }
  //   if (!data.side) {
  //     throw Error('Need pass order side');
  //   }
  //   if (!data.volume) {
  //     throw Error('Need pass order volume');
  //   }
  //   const symbol = data.pair.replace('/', '');
  //   return fetch(`${this.BASE}/api/v1/exchangeInfo`)
  //     .then(r => r.json())
  //     .then(exchangeInfo => {
  //       const symbolInfo = exchangeInfo.symbols.find(e => e.symbol === symbol);
  //       if (!symbolInfo) {
  //         throw Error('You pass wrong symbol');
  //       }
  //       const lotFilter = symbolInfo.filters.find(el => el.filterType === 'LOT_SIZE');
  //       const step = +lotFilter.stepSize;
  //
  //       const priceFilter = symbolInfo.filters.find(el => el.filterType === 'PRICE_FILTER');
  //       const precision = +priceFilter.tickSize;
  //
  //       const one = new Decimal(1);
  //       const step_d = new Decimal(step);
  //       const precision_d = new Decimal(precision);
  //       const volume_d = new Decimal(data.volume);
  //       const price_d = new Decimal(data.price);
  //
  //       const volumePres = volume_d
  //         .div(step_d)
  //         .floor()
  //         .mul(step_d);
  //       const pricePres = price_d
  //         .div(precision_d)
  //         .floor()
  //         .mul(precision_d);
  //       // const volumePres = Math.floor(data.volume / step) / (1 / step);
  //       // const pricePres = Math.floor(data.price / precision) / (1 / precision);
  //
  //       if (data.type === 'market') {
  //         const payload = {
  //           recvWindow: RecvWindow,
  //           symbol,
  //           type: this.types[data.type],
  //           side: data.side.toUpperCase(),
  //           quantity: volumePres.toNumber(),
  //         };
  //         return this._pCall('/v3/order', payload, 'POST', credentials).then(r => {
  //           if (!r.orderId) {
  //             throw Error(r.msg);
  //           }
  //           return this.getAllOrders(credentials, {
  //             pair: data.pair,
  //             status: '',
  //             orderId: r.orderId,
  //           });
  //         });
  //         // .then(r => this.getAllOrders(pair_req, "", order_id))
  //       }
  //       if (data.type === 'limit') {
  //         if (!data.price) {
  //           throw Error('Need pass order price');
  //         }
  //
  //         const payload = {
  //           recvWindow: RecvWindow,
  //           symbol,
  //           type: this.types[data.type],
  //           side: data.side.toUpperCase(),
  //           quantity: volumePres.toNumber(),
  //           price: pricePres.toNumber(),
  //           timeInForce: 'GTC',
  //         };
  //         return this._pCall('/v3/order', payload, 'POST', credentials).then(r => {
  //           if (!r.orderId) {
  //             throw Error(r.msg);
  //           }
  //           return this.getAllOrders(credentials, {
  //             pair: data.pair,
  //             status: '',
  //             orderId: r.orderId,
  //           });
  //         });
  //       }
  //       // else if (type === 'stop_loss') {
  //       //   if (!stopPrice) {
  //       //     throw Error("Need pass order price")
  //       //   }
  //       //
  //       //   const data = {
  //       //     recvWindow : RecvWindow,
  //       //     symbol     : symbol,
  //       //     type       : this.types[type],
  //       //     side       : side.toUpperCase(),
  //       //     quantity   : volume,
  //       //     stopPrice  : stopPrice
  //       //   };
  //       //   return this._pCall('/v3/order', data, "POST")
  //       // }
  //       // else if (type === 'stop_loss_limit') {
  //       // }
  //       // else if (type === 'take_profit') {
  //       // }
  //       // else if (type === 'take_profit_limit') {
  //       // }
  //
  //       throw Error('Unexpected order type');
  //     });
  // }
}
