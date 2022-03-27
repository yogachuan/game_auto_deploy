const url = require('url')
const querystring = require('querystring')
const address = require('address');
const { Client } = require('ssh2');
const iconv = require('iconv-lite');
const axios = require('axios');
const tcpPortUsed = require('tcp-port-used');
let port = 7001;

const router = {
  get: {
    getParams: async ({req})=> { // 获取传参
      const {query} = url.parse(req.url)
      return querystring.parse(decodeURI(query))
    },
    "/api/getDockerList": async ({res}, { ip })=>{
      let dockers = await dockerLi(ip);
      //console.log(dockers.length);
      let result={
        code:500,
        message:'请检查docker宿主机ip是否正确，是否开启了docker接口', 
      }
      if(JSON.stringify(dockers).includes('请检查')){        
        return res.end(JSON.stringify(result));
      }
      Object.assign(result,{
        code:200,
        message:'获取docker信息成功', 
        data:dockers
      })
      res.end(JSON.stringify(result));
    },
    "/api/getServerStatus": async ({res},{containerName,ip,csPort}) => {
      let result = {
        code:500,
        message:'服务未启动'
      }
      let dockerPid = await getDockerPid(containerName,ip);
      console.log('dockerPid: ', dockerPid);
      if(dockerPid === '容器不存在'){
        Object.assign(result,{
          code:501,
          message:containerName + '容器不存在'
        })
        return res.end(JSON.stringify(result));
      }
      else if(dockerPid === '请检查docker宿主机ip是否正确，是否开启了docker接口'){
        Object.assign(result,{
          code:502,
          message:dockerPid
        })
        return res.end(JSON.stringify(result));
      }
      let portStatus = await getServerPortStatus(dockerPid,csPort,ip)
      if(portStatus.includes('fancy-server')){
        Object.assign(result,{
          code:200,
          message:'服务正在运行',
          data:portStatus.toString()
        })
        res.end(JSON.stringify(result));
      }
      return res.end(JSON.stringify(result));
    },
    "/api/getServerData": async ({res},{containerList}) => {
      if (!containerList) throw new Error('containerList 不能为空');
      containerList = JSON.parse(containerList);
      let result = {
        code:500,
        message:'失败'
      }
      let data = [];
      for(let {ip,containers} of containerList){
        for(let item of containers){
          let url = `http://${ip}:8088/containers/${item}/json`;
          let resdata = await getDockerData(url);
          let containerName = '';
          let serverStatus = '';
          let startTime = '';
          let portBindings = '';
          let exposedPorts = [];
          if(resdata !== ''){
            containerName = resdata.Name.replace(/\//g,'');
            serverStatus = resdata.State.Status;
            startTime = resdata.Created;
            portBindings = resdata.HostConfig.PortBindings;
            for(let i in portBindings){
              exposedPorts.push(portBindings[i][0].HostPort)
            }
          }else{
            containerName = item;
            serverStatus = 'not exist';
            startTime = null;
            exposedPorts = null;
          }
          data.push({
            ip,
            containerName,
            serverStatus,
            startTime,
            exposedPorts
          })
        }
      }
      Object.assign(result,{
        code:200,
        message:'成功',
        data:data
      })
      res.end(JSON.stringify(result));      
    }
  },
  post: {
    getParams: async ({req})=> { // 获取传参
      return new Promise((resolve, reject) => {
        req.on('data', function (chunk) {
          let body = querystring.parse(`${chunk}`)
          body = Object.keys(body)
          body = body && body.length? body[0]:'{}'
          resolve(JSON.parse(body))
        })
      })
    },
    "/api/handleDeployment": async ({res},{containerName,ip,serverAddr,csPort,callbackUrl,command=''})=>{
      console.log(command)  
      if(!containerName) throw new Error('containerName 不能为空');
      if(!ip) throw new Error('ip 不能为空');
      if(!serverAddr) throw new Error('serverAddr 不能为空');
      if(!csPort) throw new Error('csPort 不能为空');
      if(!callbackUrl) throw new Error('callbackUrl 不能为空');  

      let result={
        code:500,
        message:'请检查docker宿主机ip是否正确，是否开启了docker接口'
      }
      //判断容器是否已有
      let dockers = await dockerLi(ip);
      if(dockers.includes('ip')){
        return res.end(JSON.stringify(result));
      }
      if(JSON.stringify(dockers).includes(containerName)){
        Object.assign(result,{
          code:501,
          message:'容器已存在',
          data:containerName
        });
        return res.end(JSON.stringify(result));
      }
      //判断端口是否可用
      let csIsUsed = await tcpPortUsed.check(csPort, ip);
      let worldIsUsed = await tcpPortUsed.check(csPort+1, ip);
      let dungeonIsUsed = await tcpPortUsed.check(csPort+2, ip)
      if(csIsUsed || worldIsUsed){
        Object.assign(result,{
          code:502,
          message:`${csPort}、${csPort+1}、${csPort+2}被占用`
        });
        return res.end(JSON.stringify(result));
      }
      else if(dungeonIsUsed){
        Object.assign(result,{
          code:502,
          message:`${csPort}、${csPort+1}、${csPort+2}被占用`
        });
        return res.end(JSON.stringify(result));
      }
      //确定容器数据库暴露端口
      let pgPort = 1111;
      for(let i of dockers[0].Ports){        
        if(i.PrivatePort === 5432){
          pgPort = i.PublicPort + 1;
          console.log('pgPort: ', pgPort);
        }
      }
      //创建容器数据映射目录
      await createDir(containerName,ip);
      //发送server压缩包
      let addr = serverAddr.replace('\\\\10.1.1.18\\','').replace(/\\/g,'/');
      let reg = "server_(.*?).zip";
      let serverZip = addr.match(reg)[1];
      console.log('serverZip: ', serverZip);
      serverZip = 10553;
      let scpRes = await scpServerZip(addr,containerName);
      if(scpRes.includes('No such file or directory')){
        await delDir(containerName,ip);
        axios.post(callbackUrl,{
          containerName:containerName,
          ip:ip,
          desc: '异常：下载失败，文件不存在',
          progress:20
        })
        .then(function (response) {
          //console.log(response);
        })
        .catch(function (error) {
          //console.log(error);
        });
        Object.assign(result,{
          code:503,
          message:'下载失败，文件不存在'
        });
        return res.end(JSON.stringify(result));
      }
      console.log('压缩包已经发送到指定位置,总体进度20%');
      await axios.post(callbackUrl,{
          containerName:containerName,
          ip:ip,
          desc: '压缩包已经发送到指定位置',
          progress:20
        })
        .then(function (response) {
          //console.log(response);
        })
        .catch(function (error) {
          //console.log(error);
        });

      //修改文件
      let modRes = await modifyFile(containerName,ip,serverZip,csPort);
      if(modRes.includes('No such file or directory')){
        await delDir(containerName,ip);
        axios.post(callbackUrl,{
          containerName:containerName,
          ip:ip,
          desc: '异常：修改文件配置失败',
          progress:40
        })
        .then(function (response) {
          //console.log(response);
        })
        .catch(function (error) {
          //console.log(error);
        });
        Object.assign(result,{
          code:504,
          message:'修改文件配置失败'
        });
        return res.end(JSON.stringify(result));
      }
      console.log('修改相关文件成功,总体进度40%');
      await axios.post(callbackUrl,{
          containerName:containerName,
          ip:ip,
          desc: '修改相关文件成功',
          progress:40 
        })
        .then(function (response) {
          //console.log(response);
        })
        .catch(function (error) {
          //console.log(error);
        });      

      //创建容器
      await createDocker(containerName,ip,pgPort,csPort);//
      console.log('创建容器成功,总体进度60%');
      await axios.post(callbackUrl,{
          containerName:containerName,
          ip:ip,
          desc: '创建容器成功',
          progress:60 
        })
        .then(function (response) {
          //console.log(response);
        })
        .catch(function (error) {
          //console.log(error);
        }); 
      let dockerPid = await getDockerPid(containerName,ip);     
      console.log('dockerPid: ', dockerPid);
      if(command !== ''){
        let resrrr = await shells(command,dockerPid,ip);
        console.log('resrrr: ', resrrr.toString());        
      }
      //暂停3秒       
      sleep(3000);
      //初始化容器内数据库
      let iniRes = await initDB(containerName,ip,dockerPid);
      if(iniRes.includes('sql init error')){
        await stopDelDocker(containerName);
        axios.post(callbackUrl,{
          containerName:containerName,
          ip:ip,
          desc: '异常：初始化数据库失败',
          progress:80 
        })
        .then(function (response) {
          //console.log(response);
        })
        .catch(function (error) {
          //console.log(error);
        });
        Object.assign(result,{
          code:505,
          message:'初始化数据库失败'
        });
        return res.end(JSON.stringify(result));
      }
      console.log('初始化数据库成功,总体进度80%');
      await axios.post(callbackUrl,{
          containerName:containerName,
          ip:ip,
          desc: '初始化数据库成功',
          progress:80 
        })
        .then(function (response) {
          //console.log(response);
        })
        .catch(function (error) {
          //console.log(error);
        });

      //启动容器内服务
      await startServer(containerName,ip,dockerPid);
      console.log('服务启动成功,总体进度100%');
      await axios.post(callbackUrl,{
          containerName:containerName,
          ip:ip,
          desc: '服务启动成功',
          progress:100
        })
        .then(function (response) {
          //console.log(response);
        })
        .catch(function (error) {
          //console.log(error);
        });
      let newDockers = await dockerLi(ip); 
      if(JSON.stringify(newDockers).includes(containerName)){
        Object.assign(result,{
          code:200,
          message:'成功',
          data:containerName + '部署成功'
        })
        res.end(JSON.stringify(result))
      }
    },
    "/api/stopServer": async ({res},{containerName,ip})=>{
      let result={
        code:500,
        message:'请检查docker宿主机ip是否正确，是否开启了docker接口'
      }
      let dockers = await dockerLi(ip);
      if(dockers.includes('ip')){
        return res.end(JSON.stringify(result));
      }
      if(!JSON.stringify(dockers).includes(containerName)){
        Object.assign(result, {
          code:501,
          message:'容器不存在',
          data:containerName
        })
        res.end(JSON.stringify(result));
      }
      await stopDelDocker(containerName,ip);
      Object.assign(result, {
          code:200,
          message:'容器停止并已删除'
      })
      res.end(JSON.stringify(result)
      );
    }
  }
}
let http = require('http');
const { resolve } = require('path');
const { ip } = require('address');
http
  .createServer(async (req, res) => {
    const {pathname} = url.parse(req.url)
    //将arg参数字符串反序列化为一个对象
    const method = req.method
    res.setHeader('Content-type', 'application/json')
    console.log('method', method, pathname)
    // 验证请求
    if (!router[method.toLocaleLowerCase()] || !router[method.toLocaleLowerCase()].getParams) {
      res.end(
        JSON.stringify({
          code: 404,
          message: 'not method',
        })
      )
      return
    }
    // 验证服务
    if (!router[method.toLocaleLowerCase()][pathname]) {
      res.end(
        JSON.stringify({
          code: 404,
          message: 'not service',
        })
      )
      return
    }
    let params = await router[method.toLocaleLowerCase()].getParams({req})
    // if (pathname!=='/api/uploadIgnoreFile') {
    //   params = await router[method.toLocaleLowerCase()].getParams({req})
    // }
    try {
      await router[method.toLocaleLowerCase()][pathname]({req, res}, params)
    } catch (error) {
      res.end(
        JSON.stringify({
          code: 402,
          message: `解析失败, ${error}`,
        })
      )
    }
  })
  .listen(port, ()=>{
	  console.info(`服务已经启动, 后端地址:http://${address.ip()}:${port}`);
  })

function getPortStatus(port){
  return new Promise((resolve,reject) => {    
      let portdata = '';
      const conn = new Client();        
      conn.on('ready', () => {
        console.log('Client :: ready');
        conn.shell((err, stream) => {
          if (err) throw err;        
          stream.on('close', () => {
          console.log('Stream :: close');          
            resolve(portdata);
            conn.end();
          }).on('data', (data) => {
            console.log('OUTPUT: ' + data);
            if(data.includes('tcp')){
              portdata = iconv.decode(Buffer.from(data), 'win1251'); 
            }         
          });    
          stream.end(`netstat -anp | grep --color=no ${port}\n
                      exit\n`);
        });
      }).connect({
        host: '10.1.1.184',
        port: 22,
        username: 'root',
        password: 'Qing9uo1O'
      });
  })
}
function getDockerData(url){
  return new Promise((resolve,reject) => {
    axios.get(url)
    .then(function (response) {
      resolve(response.data)
    })        
    .catch(function (error) {
      if(error.response){
        if (error.response.status === 404) {
          console.log(error.response.status)
          resolve('');
        }
      }
      else if(error.code === 'ECONNREFUSED'){
        resolve('');
      }
    });
  });
}
function createDir(dockerName,ip){
  return new Promise((resolve,reject) => {
    const conn = new Client();
    let creResult = '';
    conn.on('ready', () => {
      console.log('Client :: ready');
      conn.shell((err, stream) => {
        if (err) throw err;
        stream.on('close', () => {
          console.log('Stream :: close');
          resolve(creResult);
          conn.end();
        }).on('data', (data) => {
          console.log('OUTPUT: ' + data);
          creResult += '\n' + data;
        });    
        stream.end(`mkdir /home/${dockerName}\n
                    cp -r /home/postgres /home/${dockerName}\n
                    exit\n`);
      });
    }).connect({
      host: ip,
      port: 22,
      username: 'root',
      password: 'Qing9uo1O'
    });
  });
}
function scpServerZip(serverAddr,dockerName){
  //18发送server压缩包至184指定目录
  return new Promise((resolve,reject) => {
    const conn = new Client();
    let scpResult = '';
    conn.on('ready', () => {
      console.log('Client :: ready');
      conn.shell((err, stream) => {
        if (err) throw err;
        stream.on('close', () => {
          console.log('Stream :: close');
          resolve(scpResult);
          conn.end();
        }).on('data', (data) => {
          console.log('OUTPUT: ' + data);
          scpResult += '\n' + data;
        });    
        stream.end(`/usr/lib/yoga/scp.sh ${serverAddr} /home/${dockerName}/postgres/kog00001\n
                    exit\n`);
      });
    }).connect({
      host: '10.1.1.18',
      port: 22,
      username: 'root',
      password: 'Qing9uo1O'
    });
  });
}
function modifyFile(dockerName,ip,serverZip,csPort){
  return new Promise((resolve,reject) => {
    const conn = new Client();
    let modResult = '';
    let worldPort = csPort + 1;
    let dungeonPort = csPort + 2;
    conn.on('ready', () => {
      console.log('Client :: ready');
      conn.shell((err, stream) => {
        if (err) throw err;
        stream.on('close', () => {
          console.log('Stream :: close');
          resolve(modResult);
          conn.end();
        }).on('data', (data) => {
          console.log('OUTPUT: ' + data);
          modResult += '\n' + data;
        });
        stream.end(`sed -i "s#pwd#/home/${dockerName}/postgres/kog00001/fancy-server#g" /home/${dockerName}/postgres/kog00001/db/initdb.sh\n
                    sed -i "s#nil#${serverZip}#g" /home/${dockerName}/postgres/kog00001/cfg_launch_win.lua\n
                    sed -i "s#cs = 10001#cs = ${csPort}#g" /home/${dockerName}/postgres/kog00001/cfg_quick_deploy.lua\n
                    sed -i "s#world = 10002#world = ${worldPort}#g" /home/${dockerName}/postgres/kog00001/cfg_quick_deploy.lua\n
                    sed -i "s#dungeon = 10003#dungeon = ${dungeonPort}#g" /home/${dockerName}/postgres/kog00001/cfg_quick_deploy.lua\n
                    chmod 777 /home/${dockerName}/postgres/kog00001/db/initdb.sh\n
                    chmod 777 /home/${dockerName}/postgres/kog00001/fancy-server\n
                    exit\n`);
      });
    }).connect({
      host: ip,
      port: 22,
      username: 'root',
      password: 'Qing9uo1O'
    });
  });
}
function createDocker(dockerName,ip,pgPort,csPort){//
  return new Promise((resolve,reject) => {
    const conn = new Client();
    let creResult = '';
    let worldPort = csPort + 1;
    let dungeonPort = csPort + 2;
    conn.on('ready', () => {
      console.log('Client :: ready');
      conn.shell((err, stream) => {
        if (err) throw err;
        stream.on('close', () => {
          console.log('Stream :: close');
          resolve(creResult);
          conn.end();
        }).on('data', (data) => {
          console.log('OUTPUT: ' + data);
          creResult += '\n' + data;
        });    
        stream.end(`docker run -d --name ${dockerName} -p ${pgPort}:5432 -p ${csPort}:${csPort} -p ${worldPort}:${worldPort} -p ${dungeonPort}:${dungeonPort} -v /home/${dockerName}:/home/${dockerName} -v /home/${dockerName}/data:/var/lib/postgresql/data -e POSTGRES_PASSWORD=123456 7d1a9318777a\n
                    exit\n`);//
      });
    }).connect({
      host: ip,
      port: 22,
      username: 'root',
      password: 'Qing9uo1O'
    });
  });
}
function initDB(dockerName,ip,dockerPid){
  return new Promise((resolve,reject) => {
    const conn = new Client();
    let initResult = '';
    conn.on('ready', () => {
      console.log('Client :: ready');
      conn.shell((err, stream) => {
        if (err) throw err;
        stream.on('close', () => {
          console.log('Stream :: close');
          conn.end();
          resolve(initResult);
        }).on('data', (data) => {
          console.log('OUTPUT: ' + data); 
          initResult += '\n' + data;
        });    
        stream.end(`sudo nsenter --target ${dockerPid} --mount --uts --ipc --net --pid\n
                    cd /home/${dockerName}/postgres/kog00001/db\n
                    ./initdb.sh\n
                    \n
                    exit\n
                    exit\n`);
      });
    }).connect({
      host: ip,
      port: 22,
      username: 'root',
      password: 'Qing9uo1O'
    });
  });
}
function startServer(dockerName,ip,dockerPid){
  return new Promise((resolve,reject) => {
    const conn = new Client();
    let startResult = '';
    conn.on('ready', () => {
      console.log('Client :: ready');
      conn.shell((err, stream) => {
        if (err) throw err;
        stream.on('close', () => {
          console.log('Stream :: close');
          conn.end();
          resolve(startResult);
        }).on('data', (data) => {
          console.log('OUTPUT: ' + data); 
          startResult += '\n' + data;
        });    
        stream.end(`sudo nsenter --target ${dockerPid} --mount --uts --ipc --net --pid\n
                    cd /home/${dockerName}/postgres/kog00001\n   
                    nohup ./fancy-server &\n
                    \n
                    exit\n
                    exit\n`);
      });
    }).connect({
      host: ip,
      port: 22,
      username: 'root',
      password: 'Qing9uo1O'
    });
  });
}
function stopDelDocker(dockerName,ip){
  return new Promise((resolve,reject) => {
    let delResult = '';
    const conn = new Client();
    conn.on('ready', () => {
      console.log('Client :: ready');
      conn.shell((err, stream) => {
        if (err) throw err;
        stream.on('close', () => {
          console.log('Stream :: close');
          resolve(delResult);
          conn.end();
        }).on('data', (data) => {
          console.log('OUTPUT: ' + data);
          delResult += '\n' + data; 
        });        
        stream.end(`docker stop ${dockerName}\n
                    docker rm ${dockerName}\n
                    rm -rf /home/${dockerName}\n
                    exit\n`);
      });
    }).connect({
      host: ip,
      port: 22,
      username: 'root',
      password: 'Qing9uo1O'
    });    
  });
}
function dockerLi(ip){
  //确保ip服务器开启了docker接口，同时端口号为8088
  return new Promise((resolve,reject) => {
    let url = `http://${ip}:8088/containers/json`
    axios.get(url)
    .then(function (response) {
      resolve(response.data)
    })        
    .catch(function (error) {
      if (error.code === 'ECONNREFUSED') {
        //console.log(error.response)
        resolve('请检查docker宿主机ip是否正确，是否开启了docker接口')
      }
    });
  });
}
function getDockerPid(dockerName,ip){
  //确保ip服务器开启了docker接口，同时端口号为8088
  return new Promise((resolve,reject) => {
    let url = `http://${ip}:8088/containers/${dockerName}/json`
    axios.get(url)
    .then(function (response) {
      resolve(response.data.State.Pid)
    })        
    .catch(function (error) {
      if(error.response){
        if (error.response.status === 404) {
          console.log(error.response.status)
          resolve('容器不存在');
        }
      }
      else if(error.code === 'ECONNREFUSED'){
        resolve('请检查docker宿主机ip是否正确，是否开启了docker接口');
      }
    });
  })
}
function delDir(dockerName,ip){
  return new Promise((resolve,reject) => {
    let delResult = '';
    const conn = new Client();
    conn.on('ready', () => {
      console.log('Client :: ready');
      conn.shell((err, stream) => {
        if (err) throw err;
        stream.on('close', () => {
          console.log('Stream :: close');
          resolve(delResult);
          conn.end();
        }).on('data', (data) => {
          console.log('OUTPUT: ' + data);
          delResult += '\n' + data; 
        });        
        stream.end(`rm -rf /home/${dockerName}\n
                    exit\n`);
      });
    }).connect({
      host: ip,
      port: 22,
      username: 'root',
      password: 'Qing9uo1O'
    });    
  });
}
function getServerPortStatus(dockerPid,csPort,ip){
  return new Promise((resolve,reject) => {
    const conn = new Client();
    let portdata = '';
    conn.on('ready', () => {
      console.log('Client :: ready');
      conn.shell((err, stream) => {
        if (err) throw err;
        stream.on('close', () => {
          console.log('Stream :: close');
          conn.end();
          resolve(portdata);
        }).on('data', (data) => {
          console.log('OUTPUT: ' + data); 
          if(data.includes('tcp')){
            portdata = iconv.decode(Buffer.from(data), 'win1251');
          }
        });    
        stream.end(`sudo nsenter --target ${dockerPid} --mount --uts --ipc --net --pid\n
                    netstat -anp | grep ${csPort}\n
                    exit\n
                    exit\n`);
      });
    }).connect({
      host: ip,
      port: 22,
      username: 'root',
      password: 'Qing9uo1O'
    });
  });
}
function shells(command,dockerPid,ip){
  return new Promise((resolve,reject) => {
    const conn = new Client();
    let result = '';
    conn.on('ready', () => {
      console.log('Client :: ready');
      conn.shell((err, stream) => {
        if (err) throw err;
        stream.on('close', () => {
          console.log('Stream :: close');
          conn.end();
          resolve(result);
        }).on('data', (data) => {
          console.log('OUTPUT: ' + data); 
          result += '\n' + data;
        });    
        stream.end(`sudo nsenter --target ${dockerPid} --mount --uts --ipc --net --pid\n
                    ${command}\n
                    exit\n
                    exit\n`);
      });
    }).connect({
      host: ip,
      port: 22,
      username: 'root',
      password: 'Qing9uo1O'
    });
  })
  
}
function sleep ( n ) { 
  var start = new Date().getTime() ;
  while ( true ) {
      if ( new Date( ).getTime( ) - start > n ) {
          // 使用  break  实现；
          break;
      }
  }
}
