$ErrorActionPreference = 'Stop'

$root = 'C:\ProgramData\WatchyTurn'
Set-Location $root

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item node_modules\node-turn\lib\allocation.js "node_modules\node-turn\lib\allocation.js.$stamp.bak"
Copy-Item node_modules\node-turn\lib\methods\refresh.js "node_modules\node-turn\lib\methods\refresh.js.$stamp.bak"
Copy-Item node_modules\node-turn\lib\methods\allocate.js "node_modules\node-turn\lib\methods\allocate.js.$stamp.bak"
Copy-Item server.cjs "server.cjs.$stamp.bak"

@'
const Address = require('./address');
const Message = require('./message');
const ChannelMsg = require('./channelMessage');

var allocation = function(msg, sockets, lifetime) {
  var self = this;
  this.transactionID = msg.transactionID;
  this.transport = msg.transport.revert();
  this.fiveTuple = msg.transport.get5Tuple();
  this.user = msg.user;
  this.server = msg.server;
  this.debug = msg.debug;
  this.sockets = sockets;
  this.relayedTransportAddress = this.getRelayedAddress(sockets[0].address());
  this.lifetime = lifetime;
  this.mappedAddress = msg.transport.src;
  this.permissions = {};
  this.channelBindings = {};
  this.destroyed = false;
  this.timeToExpiry = Date.now() + (this.lifetime * 1000);
  this.server.allocations[this.fiveTuple] = this;
  this.timer = setTimeout(function() {
    self.destroy('expired');
  }, this.lifetime * 1000);

  this.sockets.forEach(function(socket) {
    socket.on('message', function(data, rinfo) {
      const from = new Address(rinfo.address, rinfo.port);
      var permission = self.permissions[from.address];

      if (!permission || permission < Date.now()) {
        var socketAddress = socket.address();
        self.debug('TRACE', 'permission fail for ' + from + ' at ' + socketAddress.address + ':' + socketAddress.port);
        return;
      }

      var channelNumber = self.getPeerChannelNumber(from);

      var channelMsg = new ChannelMsg();
      if (channelMsg.read(data)) {
        if (!channelNumber) {
          return;
        }
        if (channelNumber !== channelMsg.channelNumber) {
          return;
        }
        data = channelMsg.data;
      }

      if (channelNumber !== void 0) {
        var msg = new ChannelMsg(channelNumber, data);
        return self.transport.socket.send(msg.write(), self.transport.dst.port, self.transport.dst.address, function(err) {
          if (err) {
            return self.debug('ERROR', err);
          }
          self.debug('TRACE', 'relaying data from' + from + ' over channelNumber ' + channelNumber + ' to ' + self.transport.dst);
        });
      }

      var DataIndication = new Message(self.server, self.transport);
      DataIndication.addAttribute('xor-peer-address', from);
      DataIndication.data(data);
    });
  });
};

allocation.prototype.destroy = function(reason) {
  if (this.destroyed) {
    return;
  }
  this.destroyed = true;
  clearTimeout(this.timer);
  delete this.server.allocations[this.fiveTuple];
  this.sockets.forEach(function(socket) {
    try {
      socket.removeAllListeners('message');
      socket.close();
    } catch (e) {
      // Socket may already be closed.
    }
  });
  this.debug('INFO', 'closed allocation ' + this.relayedTransportAddress + (reason ? ' reason: ' + reason : ''));
};

allocation.prototype.update = function(lifetime) {
  var self = this;
  clearTimeout(this.timer);
  if (lifetime === void 0 || lifetime === null) {
    lifetime = this.lifetime;
  }
  lifetime = Number(lifetime);
  if (!Number.isFinite(lifetime) || lifetime < 0) {
    lifetime = this.lifetime;
  }
  if (lifetime === 0) {
    this.destroy('refresh-zero');
    this.timeToExpiry = Date.now();
    return this.timeToExpiry;
  }
  this.lifetime = lifetime;
  this.debug('TRACE', 'updating allocation ' + this.relayedTransportAddress + ' lifetime: ' + lifetime);
  this.timer = setTimeout(function() {
    self.destroy('expired');
  }, lifetime * 1000);
  this.timeToExpiry = Date.now() + (lifetime * 1000);
  return this.timeToExpiry;
};

allocation.prototype.permit = function(address) {
  this.debug('TRACE', 'add permission for ' + address + ' to allocation ' + this.relayedTransportAddress);
  this.permissions[address] = Date.now() + 300000;
};

allocation.prototype.getPeerChannelNumber = function(peer) {
  var self = this;
  var channelNumber = void 0;
  var peerAddress = peer.toString();
  Object.keys(self.channelBindings).forEach(function(chanNumber) {
    var channel = self.channelBindings[chanNumber];
    if (channel && channel.toString() === peerAddress) {
      channelNumber = parseInt(chanNumber);
    }
  });
  return channelNumber;
};

allocation.prototype.getRelayedAddress = function(relayed) {
  var address = relayed.address;
  var port = relayed.port;
  var external = this.server.externalIps;
  if (external) {
    if (typeof(external) == "string")
      address = external;
    else
      address = external[address] || external.default || address;
  }
  return new Address(address, port);
};

module.exports = allocation;
'@ | Set-Content -Path node_modules\node-turn\lib\allocation.js -Encoding UTF8

@'
var refresh = function(server) {
  var self = this;
  this.server = server;

  this.server.on('refresh', function(msg, reply) {
    self.refresh(msg, reply);
  });
};

refresh.prototype.refresh = function(msg, reply) {
  var desiredLifetime = this.server.defaultAllocatetLifetime;
  var lifetime = msg.getAttribute('lifetime');
  if (lifetime !== void 0) {
    if (lifetime === 0) {
      desiredLifetime = 0;
    } else {
      desiredLifetime = Math.min(lifetime, this.server.maxAllocateLifetime);
    }
  }

  if (desiredLifetime === 0) {
    msg.allocation.update(0);
  } else {
    msg.allocation.update(desiredLifetime);
  }
  reply.addAttribute('lifetime', desiredLifetime);
  reply.addAttribute('software', this.server.software);
  reply.addAttribute('message-integrity');
  reply.resolve();
};

module.exports = refresh;
'@ | Set-Content -Path node_modules\node-turn\lib\methods\refresh.js -Encoding UTF8

(Get-Content node_modules\node-turn\lib\methods\allocate.js -Raw).Replace("msg.getAttribute('liftetime')", "msg.getAttribute('lifetime')") |
  Set-Content -Path node_modules\node-turn\lib\methods\allocate.js -Encoding UTF8

$server = Get-Content server.cjs -Raw
$server = $server -replace "const log = \(level, message\) => \{[\s\S]*?\};", @'
const log = (level, message) => {
  const severity = String(level || '').toUpperCase();
  if (!['WARN', 'ERROR', 'FATAL'].includes(severity)) return;
  fs.appendFileSync(logPath, new Date().toISOString() + ' [' + severity + '] ' + message + '\n');
};
'@
$server = $server -replace "debugLevel: 'INFO'", "debugLevel: 'WARN'"
Set-Content -Path server.cjs -Value $server -Encoding UTF8

if (Test-Path turn.log) {
  Move-Item turn.log "turn.$stamp.log"
}

Restart-ScheduledTask -TaskName WatchyTurn
Start-Sleep -Seconds 3

$procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'WatchyTurn|server\.cjs' }
$pids = $procs.ProcessId
$eps = Get-NetUDPEndpoint | Where-Object { $pids -contains $_.OwningProcess }
$relays = $eps | Where-Object { $_.LocalPort -ge 50000 -and $_.LocalPort -le 50100 }

[pscustomobject]@{
  ProcessId = ($pids -join ',')
  TotalUdp = $eps.Count
  RelayUdp = $relays.Count
  MinRelay = ($relays.LocalPort | Measure-Object -Minimum).Minimum
  MaxRelay = ($relays.LocalPort | Measure-Object -Maximum).Maximum
  LogExists = (Test-Path turn.log)
  Backups = $stamp
} | Format-List
