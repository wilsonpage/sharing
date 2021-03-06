import /* global HTTPServer */ 'p2p/fxos-web-server';
import /* global P2PHelper */ 'p2p/p2p_helper';

import { Service } from 'fxos-mvc/dist/mvc';

import AppsService from 'app/js/services/apps_service';

// Enable this if you want the device to pretend that it's connected to another
// device and request its own apps.
//window.TEST_MODE = true;

var singletonGuard = {};
var instance;

export default class P2pService extends Service {
  constructor(guard) {
    if (guard !== singletonGuard) {
      console.error('Cannot create singleton class');
      return;
    }

    super();

    this._peerName = null;
    this._connectedIp = window.TEST_MODE ? 'http://127.0.0.1:8080' : null;

    this._proximityApps = {};
    this._proximityAddons = {};

    AppsService.instance.getInstalledApps().then((apps) => {
      this._installedApps = apps;
    });

    this._initialized = new Promise((resolve, reject) => {
      navigator.mozSettings.addObserver('lightsaber.p2p_broadcast', (e) => {
        this._broadcastLoaded(e.settingValue);
      });

      var broadcastSetting = navigator.mozSettings.createLock().get(
        'lightsaber.p2p_broadcast', false);

      broadcastSetting.onsuccess = () => {
        this._broadcastLoaded(
          broadcastSetting.result['lightsaber.p2p_broadcast']);
        resolve();
      };

      broadcastSetting.onerror = () => {
        console.error('error getting `lightsaber.p2p_broadcast` setting');
        reject();
      };
    });

    window.addEventListener('visibilitychange', P2PHelper.restartScan);

    window.addEventListener(
      'beforeunload', this._deactivateHttpServer.bind(this));

    setTimeout(() => {
      this._peerName = 'asdf';
      this._appsUpdated([
        {manifest: {name: 'Sharing', description: 'doo'}, owner: 'Doug'},
        {manifest: {name: 'HelloWorld', description: 'too'}, owner: 'Ham'},
        {manifest: {name: 'test', description: 'ham'}, owner: 'Hurr'}]);
    }, 2000);

    setTimeout(() => {
      this._peerName = 'foo';
      this._appsUpdated([]);
    }, 4000);
  }

  static get instance() {
    if (!instance) {
      instance = new this(singletonGuard);
    }
    return instance;
  }

  _broadcastLoaded(val) {
    this._broadcast = val;
    if (this._broadcast) {
      this._activateHttpServer();
    } else {
      this._deactivateHttpServer();
    }
    this._dispatchEvent('broadcast');
  }

  downloadApp(appName) {
    var apps = AppsService.instance.flatten(this._proximityApps);
    console.log('scanning in ' + JSON.stringify(apps));
    for (var i = 0; i < apps.length; i++) {
      var app = apps[i];
      console.log('found matching app: ' + JSON.stringify(app));
      if (appName === app.manifest.name) {
        AppsService.instance.installApp(app);
        break;
      }
    }
  }

  get broadcast() {
    return this._broadcast;
  }

  set broadcast(enable) {
    navigator.mozSettings.createLock().set({
     'lightsaber.p2p_broadcast': enable});
  }

  get proximityApps() {
    return this._proximityApps;
  }

  get proximityAddons() {
    return this._proximityAddons;
  }

  _activateHttpServer() {
    if (this.httpServer) {
      return;
    }

    this.httpServer = new HTTPServer(8080);
    this.httpServer.addEventListener('request', (evt) => {
      var response = evt.response;
      var request = evt.request;

      console.log('got request! ' + request.path);
      console.log(request.params);

      var path = request.path;
      if (path !== '/') {
        var appName = request.params.app;
        this._installedApps.forEach((app) => {
          if (app.manifest.name === appName) {
            console.log('found a match');
            if (path === '/manifest.webapp') {
              response.headers['Content-Type'] =
                'application/x-web-app-manifest+json';
              console.log('processing as manifest request');
              var manifest = app.manifest;
              manifest.installs_allowed_from = ['*'];
              manifest.package_path = '/download?app=' + appName;
              console.log(JSON.stringify(manifest));
              response.send(JSON.stringify(manifest));
            } else if (path === '/download') {
              app.export().then((blob) => {
                response.send(blob);
              });
            }
          }
        });
      } else {
        response.send(AppsService.instance.pretty(this._installedApps));
      }
    });
    this.httpServer.start();

    if (!window.P2PHelper) {
      window.alert('WiFi Direct is not available on this device.');
      window.close();
      return;
    }

    P2PHelper.addEventListener('peerlistchange', (evt) => {
      if (!this._connectedIp) {
        this._connectToFirstPeer(evt.peerList);
      }

      for (var index in evt.peerList) {
        var peer = evt.peerList[index];
        if (!this._proximityApps[peer.name]) {
          this._setProximityApps(peer.name, {});
        }
      }
    });

    P2PHelper.addEventListener('connected', (evt) => {
      console.log('connected! ' + evt.groupOwner.ipAddress);
      this._connectedIp = 'http://' + evt.groupOwner.ipAddress + ':8080';
      this._requestApps();
    });

    P2PHelper.addEventListener('disconnected', () => {
      console.log('disconnected!');

      // XXX/drs: Suggestion from justindarc to improve stability.
      P2PHelper.disconnect();
      P2PHelper.startScan();

      this._connectedIp = null;
      this._peerName = null;

      var wifiP2pManager = navigator.mozWifiP2pManager;
      var request = wifiP2pManager.getPeerList();
      request.onsuccess = () => {
        var peers = request.result;
        setTimeout(() => {
          this._connectToFirstPeer(peers);
        }, 500);
      };
    });

    P2PHelper.setDisplayName('P2P Web Server ' + P2PHelper.localAddress);

    P2PHelper.startScan();
  }

  _connectToPeer(peer) {
    if (this._connectTimer) {
      return;
    }

    this._peerName = peer.name;
    this._connectTimer = setTimeout(() => {
      console.log('connecting to peer!');
      this._connectTimer = null;

      // XXX/drs: Suggestion from justindarc to improve stability.
      P2PHelper.stopScan();
      P2PHelper.connect(peer.address);
    }, 5000);
  }

  _connectToFirstPeer(peers) {
    var connectToPeer;

    for (var i = 0; i < peers.length; i++) {
      var peer = peers[i];
      if (!this._proximityApps[peer.name]) {
        connectToPeer = peer;
      }
    }

    // We've already connected to every peer and queried them for their apps.
    // Re-connect to the one that we were connected to the oldest time ago.
    if (!connectToPeer) {
      for (i = 0; i < peers.length; i++) {
        var oldPeer = peers[i];
        if (!connectToPeer || oldPeer.connectedTs < connectToPeer.connectedTs) {
          connectToPeer = oldPeer;
        }
      }
    }

    if (connectToPeer) {
      this._connectToPeer(connectToPeer);
    }
  }

  _deactivateHttpServer() {
    this.httpServer.stop();
    this.httpServer = null;

    P2PHelper.disconnect();
    P2PHelper.stopScan();
  }

  _requestApps() {
    console.log('1 connected ip is: ' + this._connectedIp);
    var xhr = new XMLHttpRequest({ mozAnon: true, mozSystem: true });
    xhr.onreadystatechange = () => {
      if (xhr.readyState === 4 && xhr.status === 200) {
        var apps = JSON.parse(xhr.responseText);
        console.log('2 connected ip is: ' + this._connectedIp);
        console.log('got : ' + xhr.responseText);
        this._appsUpdated(apps);
      }
    };

    xhr.open('GET', this._connectedIp);
    xhr.send();
  }

  _appsUpdated(apps) {
    console.log('3 connected ip is: ' + this._connectedIp);
    apps.forEach((_, index) => {
      var app = apps[index];
      app.url = this._connectedIp;
      if (!app.type) {
        app.type = 'packaged';
      }
    });

    this._setProximityApps(this._peerName, apps);

    P2PHelper.disconnect();
    P2PHelper.startScan();
  }

  _setProximityApps(peerName, apps) {
    this._proximityApps[peerName] = {
      name: peerName,
      apps: apps,
      connectedTs: +new Date()
    };
    this._dispatchEvent('proximity');
  }
}
