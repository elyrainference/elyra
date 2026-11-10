// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockUSDG} from "./MockUSDG.sol";

interface IEscrow {
    function redeem(address consumer, uint256 cumulative, bytes calldata sig) external;
}

interface ITokenReceiver {
    function onTokenReceived() external;
}

/// Test helper: ERC-20 that calls back into the recipient (if it is a contract) during transfer.
contract HookToken is MockUSDG {
    function _transfer(address from, address to, uint256 amount) internal override {
        super._transfer(from, to, amount);
        if (to.code.length != 0) { try ITokenReceiver(to).onTokenReceived() {} catch {} }
    }
}

/// Test helper: takes a 1% fee on every transfer (must be rejected by deposit).
contract FeeToken is MockUSDG {
    function _transfer(address from, address to, uint256 amount) internal override {
        require(to != address(0), "to zero");
        require(balanceOf[from] >= amount, "balance");
        uint256 fee = amount / 100;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        totalSupply -= fee;
        emit Transfer(from, to, amount - fee);
    }
}

/// Test helper: non-standard token whose transfer/transferFrom return no value (like old USDT).
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint8 public decimals;

    constructor(uint8 d) { decimals = d; }

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        require(allowance[from][msg.sender] >= amount, "allowance");
        require(balanceOf[from] >= amount, "balance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// Test helper: token whose outgoing transfers can be switched off (policy block); `returnFalse` makes it
/// return false instead of reverting. Incoming transferFrom always works.
contract BlockableToken is MockUSDG {
    bool public blocked;
    bool public returnFalse;

    function setBlocked(bool b, bool rf) external { blocked = b; returnFalse = rf; }

    function transfer(address to, uint256 amount) external override returns (bool) {
        if (blocked) {
            if (returnFalse) return false;
            revert("blocked by policy");
        }
        _transfer(msg.sender, to, amount);
        return true;
    }
}

/// Test helper: a provider that tries to re-enter redeem() when it receives tokens.
contract ReentrantProvider is ITokenReceiver {
    IEscrow public escrow;
    address public consumer;
    uint256 public cumulative;
    bytes public sig;
    uint256 public reentries;
    bool public reentrySucceeded;

    constructor(IEscrow e) { escrow = e; }

    function attack(address c, uint256 cum, bytes calldata s) external {
        consumer = c; cumulative = cum; sig = s;
        escrow.redeem(c, cum, s);
    }

    function onTokenReceived() external {
        if (reentries < 2) {
            reentries++;
            try escrow.redeem(consumer, cumulative, sig) { reentrySucceeded = true; } catch {}
        }
    }
}

interface IRegistry {
    function announce(bytes32 nodeId, bytes32 boxKey, string calldata url, bytes32 metaHash, uint64 ttl) external;
    function requestWithdraw() external;
    function withdraw() external;
}

/// Test helper: a seller contract that tries to re-enter the registry's withdraw() when its bond comes back.
contract ReentrantSeller is ITokenReceiver {
    IRegistry public registry;
    uint256 public reentries;
    bool public reentrySucceeded;

    constructor(IRegistry r) { registry = r; }

    function announce(address token, uint256 bond) external {
        MockUSDG(token).approve(address(registry), bond);
        registry.announce(bytes32(uint256(1)), bytes32(uint256(2)), "https://seller.example", bytes32(0), 0);
    }
    function exit() external { registry.requestWithdraw(); }
    function pull() external { registry.withdraw(); }

    function onTokenReceived() external {
        if (reentries < 2) {
            reentries++;
            try registry.withdraw() { reentrySucceeded = true; } catch {}
            try registry.announce(bytes32(uint256(1)), bytes32(uint256(2)), "https://x.example", bytes32(0), 0) { reentrySucceeded = true; } catch {}
        }
    }
}
