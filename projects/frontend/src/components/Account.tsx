import { useWallet } from '@txnlab/use-wallet-react'
import { useEffect, useMemo, useState } from 'react'
import { algorand } from '../lib/algorand'
import { formatAlgo } from '../lib/format'
import { ellipseAddress } from '../utils/ellipseAddress'
import { getAlgodConfigFromViteEnvironment } from '../utils/network/getAlgoClientConfigs'

const Account = () => {
  const { activeAddress } = useWallet()
  const algoConfig = getAlgodConfigFromViteEnvironment()
  const [balanceMicroAlgos, setBalanceMicroAlgos] = useState<bigint | null>(null)

  const networkName = useMemo(() => {
    return algoConfig.network === '' ? 'localnet' : algoConfig.network.toLocaleLowerCase()
  }, [algoConfig.network])

  useEffect(() => {
    if (!activeAddress) {
      setBalanceMicroAlgos(null)
      return
    }
    let cancelled = false
    algorand.account
      .getInformation(activeAddress)
      .then((info) => {
        if (!cancelled) setBalanceMicroAlgos(info.balance.microAlgo)
      })
      .catch(() => {
        if (!cancelled) setBalanceMicroAlgos(null)
      })
    return () => {
      cancelled = true
    }
  }, [activeAddress])

  return (
    <div>
      <a
        className="text-xl"
        target="_blank"
        rel="noreferrer"
        href={`https://lora.algokit.io/${networkName}/account/${activeAddress ?? ''}/`}
      >
        Address: {ellipseAddress(activeAddress)}
      </a>
      <div className="text-xl">Network: {networkName}</div>
      {balanceMicroAlgos !== null && <div className="text-xl">Balance: {formatAlgo(balanceMicroAlgos)} ALGO</div>}
    </div>
  )
}

export default Account
